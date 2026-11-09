"""Jobs: ingest (link / upload) -> Gemini 3.5 transcription in short pieces (stage 1)
-> Gemini 3.5 editing pass with the sources page (stage 2). No Whisper."""
import datetime, glob, json, os, queue, re, shutil, subprocess, threading, time, traceback
from concurrent.futures import ThreadPoolExecutor
from . import gemini, sources

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("TIMLUL_DATA") or os.path.join(os.path.dirname(ROOT), "data")
JOBS = os.path.join(DATA, "jobs")
PROMPTS = os.path.join(ROOT, "prompts")
MAX_SECONDS = 3 * 3600
PIECE = 120               # stage 1: seconds of audio per transcription call (gives a timestamp every ~2 min)
PIECE_PAR = int(os.environ.get("TIMLUL_PIECE_PAR", "5"))
CHUNK = 30 * 60           # stage 2: ~30 minutes of transcript per editing call
REF_MAX = 60000
KEEP_DAYS = int(os.environ.get("TIMLUL_KEEP_DAYS", "14"))
FFMPEG = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/usr/bin/ffprobe"
YTDLP = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")
os.makedirs(JOBS, exist_ok=True)

_lock = threading.RLock()
_q = queue.Queue()
ID_RE = re.compile(r"[A-Za-z0-9_-]{20,40}")


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def jdir(jid):
    if not ID_RE.fullmatch(jid or ""):
        raise KeyError(jid)
    return os.path.join(JOBS, jid)


def load(jid):
    with open(os.path.join(jdir(jid), "job.json"), encoding="utf-8") as f:
        return json.load(f)


def save(job):
    p = os.path.join(jdir(job["id"]), "job.json")
    with _lock:
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False, indent=1)
        os.replace(p + ".tmp", p)


def update(jid, **kw):
    with _lock:
        j = load(jid); j.update(kw); j["updated"] = now(); save(j); return j


def log(jid, msg):
    with open(os.path.join(jdir(jid), "log.txt"), "a", encoding="utf-8") as f:
        f.write(f"{datetime.datetime.now():%H:%M:%S} {msg}\n")


def all_jobs():
    out = []
    for p in glob.glob(os.path.join(JOBS, "*", "job.json")):
        try: out.append(json.load(open(p, encoding="utf-8")))
        except Exception: pass
    return out


def ts(x):
    x = int(x); h, m, s = x // 3600, x % 3600 // 60, x % 60
    return f"[{h}:{m:02d}:{s:02d}]" if h else f"[{m}:{s:02d}]"


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def dur_of(path):
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    try: return float(r.stdout.strip().splitlines()[0])
    except Exception: return 0.0


# ---------------- ingest ----------------
def download(jid, url):
    d = jdir(jid)
    update(jid, status="downloading", stage=1, progress=0, message="מוריד את השמע מהקישור…")
    env = dict(os.environ, PATH=os.path.expanduser("~/.local/bin") + ":" + os.environ.get("PATH", ""))
    # refuse very long items before downloading them
    r = run([YTDLP, "--no-playlist", "--skip-download", "--print", "duration", "--print", "title", url], env=env, timeout=180)
    lines = r.stdout.strip().splitlines()
    try:
        if lines and float(lines[0]) > MAX_SECONDS:
            raise RuntimeError(f"השיעור ארוך מדי ({int(float(lines[0]) // 60)} דקות). המגבלה היא 3 שעות.")
    except ValueError:
        pass
    if len(lines) > 1 and lines[1].strip():
        j = load(jid)
        if not j.get("title_set"):
            update(jid, title=lines[1].strip()[:200])
    r = run([YTDLP, "-f", "bestaudio/best", "--no-playlist", "--no-part", "--force-overwrites", "--max-filesize", "2G",
             "-o", os.path.join(d, "source.%(ext)s"), url], env=env, timeout=3 * 3600)
    files = [f for f in glob.glob(os.path.join(d, "source.*")) if not f.endswith((".json", ".part", ".ytdl"))]
    if r.returncode != 0 or not files:
        log(jid, "yt-dlp failed: " + r.stderr[-1500:])
        err = (r.stderr.strip().splitlines() or ["?"])[-1]
        err = re.sub(r"https?://\S+", "", err)[:160]
        raise RuntimeError("לא הצלחתי להוריד את השמע מהקישור. ייתכן שהקישור פרטי, חסום או לא נתמך. (" + err + ")")
    return files[0]


def to_audio(jid, src):
    """Compact mono 16 kHz MP3 – what Gemini actually listens to."""
    dur = dur_of(src)
    if dur > MAX_SECONDS:
        raise RuntimeError(f"השיעור ארוך מדי ({int(dur // 60)} דקות). המגבלה היא 3 שעות.")
    update(jid, status="converting", stage=1, message="מכין את השמע…", duration=dur or None)
    out = os.path.join(jdir(jid), "audio.mp3")
    if os.path.abspath(src) == out:
        update(jid, duration=dur); return out, dur
    r = run([FFMPEG, "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out])
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("לא הצלחתי לקרוא את הקובץ. ודאו שזה קובץ שמע או וידאו תקין.")
    dur = dur_of(out)
    if dur > MAX_SECONDS:
        raise RuntimeError(f"השיעור ארוך מדי ({int(dur // 60)} דקות). המגבלה היא 3 שעות.")
    if dur < 1:
        raise RuntimeError("לא נמצא שמע בקובץ")
    try: os.remove(src)          # keep only the compact audio
    except OSError: pass
    update(jid, duration=dur)
    return out, dur


def silences(path):
    r = run([FFMPEG, "-v", "info", "-i", path, "-af", "silencedetect=noise=-32dB:d=0.35", "-f", "null", "-"])
    s = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    e = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return [(a + b) / 2 for a, b in zip(s, e)]


def cut_points(path, dur):
    """~PIECE-second pieces, cut in a pause near each boundary so words aren't split."""
    sil = silences(path) if dur > PIECE * 1.5 else []
    pts, t = [0.0], 0.0
    while dur - t > PIECE * 1.4:
        target = t + PIECE
        near = [x for x in sil if target - 25 <= x <= target + 25]
        nxt = min(near, key=lambda x: abs(x - target)) if near else target
        pts.append(nxt); t = nxt
    pts.append(dur)
    return list(zip(pts[:-1], pts[1:]))


# ---------------- sources ----------------
def extract_sources(jid):
    d = jdir(jid); j = load(jid); parts, notes = [], []
    if j.get("sources_text"):
        parts.append(j["sources_text"].strip())
        notes.append({"name": "טקסט שהודבק", "note": "טקסט", "chars": len(j["sources_text"])})
    for name in j.get("sources_files", []):
        p = os.path.join(d, "sources", name)
        try:
            txt, note = sources.extract_file(p, log=lambda m: log(jid, m))
        except Exception as e:
            txt, note = "", "לא הצלחתי לקרוא את הקובץ"
            log(jid, f"sources error {name}: {e}")
        if txt:
            parts.append(f"=== {name} ===\n{txt}")
        notes.append({"name": name, "note": note, "chars": len(txt)})
    text = "\n\n".join(parts).strip()
    open(os.path.join(d, "sources.txt"), "w", encoding="utf-8").write(text)
    update(jid, sources_notes=notes, sources_chars=len(text))
    return text


def prompt(name, ref):
    return open(os.path.join(PROMPTS, name), encoding="utf-8").read().replace("{referenceText}", (ref or "(אין)")[:REF_MAX])


# ---------------- stage 1: Gemini 3.5 transcription ----------------
def stage1(jid, audio, dur, ref):
    pieces = cut_points(audio, dur)
    d = jdir(jid); tmp = os.path.join(d, "pieces"); os.makedirs(tmp, exist_ok=True)
    raw_prompt = prompt("raw_he.txt", ref[:8000])
    results = [None] * len(pieces); models = {}; done = [0]; t0 = time.time()
    update(jid, status="transcribing", stage=1, progress=0, pieces=len(pieces),
           message=f"מתמלל עם Gemini 3.5… 0 מתוך {len(pieces)} קטעים")

    def one(i):
        a, b = pieces[i]
        p = os.path.join(tmp, f"p{i:03d}.mp3")
        r = run([FFMPEG, "-v", "error", "-y", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", audio, "-c", "copy", p])
        if r.returncode != 0:
            run([FFMPEG, "-v", "error", "-y", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", audio, "-ac", "1", "-b:a", "32k", p])
        data = open(p, "rb").read()
        txt, m = gemini.generate([gemini.inline(data, "audio/mpeg"), {"text": raw_prompt}], gemini.TRANSCRIBE_PREF,
                                 max_tokens=16384, log=lambda x: log(jid, f"piece {i}: {x}"), timeout=300, tries=4)
        txt = re.sub(r"\s+", " ", txt).strip()
        with _lock:
            results[i] = {"start": round(a, 2), "end": round(b, 2), "text": txt}
            models[m] = models.get(m, 0) + 1; done[0] += 1
            el = time.time() - t0
            json.dump([x for x in results if x], open(os.path.join(d, "raw.json"), "w", encoding="utf-8"), ensure_ascii=False)
            update(jid, progress=done[0] / len(pieces), elapsed1=el, models1=models,
                   eta=el / done[0] * (len(pieces) - done[0]),
                   message=f"מתמלל עם Gemini 3.5… {done[0]} מתוך {len(pieces)} קטעים")

    with ThreadPoolExecutor(PIECE_PAR) as ex:
        list(ex.map(one, range(len(pieces))))
    shutil.rmtree(tmp, ignore_errors=True)
    segs = [x for x in results if x and x["text"]]
    json.dump(segs, open(os.path.join(d, "raw.json"), "w", encoding="utf-8"), ensure_ascii=False)
    log(jid, f"stage1 done: {len(segs)} pieces in {time.time() - t0:.0f}s, models {models}")
    update(jid, progress=1, raw_ready=True, eta=0, models1=models, elapsed1=time.time() - t0)
    return segs


# ---------------- stage 2: Gemini 3.5 editing with sources ----------------
def strip_fence(t):
    return re.sub(r"^```(?:markdown|md)?\s*\n|\n```\s*$", "", t.strip()).strip()


def stage2(jid, segs, ref):
    if not segs:
        raise RuntimeError("התמלול הראשוני ריק – אין מה לערוך")
    base = prompt("correct_he.txt", ref)
    j = load(jid)
    if j.get("title"):
        base += f"\nכותרת השיעור: {j['title']}\n"
    chunks = []
    for s in segs:
        off = int(s["start"] // CHUNK)
        if not chunks or chunks[-1][0] != off:
            chunks.append((off, []))
        chunks[-1][1].append(f"{ts(s['start'])} {s['text']}")
    n = len(chunks); outs = [None] * n; models = {}; done = [0]; t0 = time.time()
    update(jid, status="correcting", stage=2, progress=0, message=f"עורך ומתקן מול המקורות… 0 מתוך {n}")

    def one(i):
        pre = "" if n == 1 else f"(זהו חלק {i + 1} מתוך {n} של השיעור. ערוך רק את החלק הזה, בלי הקדמה ובלי נספחים.)\n\n"
        txt, m = gemini.generate([{"text": base}, {"text": pre + "התמלול הגולמי:\n\n" + "\n".join(chunks[i][1])}],
                                 gemini.CORRECT_PREF, log=lambda x: log(jid, f"edit {i}: {x}"), timeout=600)
        with _lock:
            outs[i] = strip_fence(txt); models[m] = models.get(m, 0) + 1; done[0] += 1
            update(jid, progress=done[0] / (n + 1), models2=models, message=f"עורך ומתקן מול המקורות… {done[0]} מתוך {n}")

    with ThreadPoolExecutor(3) as ex:
        list(ex.map(one, range(n)))
    body = "\n\n".join(outs)
    d = jdir(jid)
    open(os.path.join(d, "corrected.md"), "w", encoding="utf-8").write(body + "\n")
    update(jid, corrected_ready=True, message="מכין נספח סיפורים ודף מקורות…")
    try:
        apx, m = gemini.generate([{"text": prompt("appendix_he.txt", ref)}, {"text": body}], gemini.CORRECT_PREF,
                                 max_tokens=8192, log=lambda x: log(jid, "appendix: " + x), timeout=300)
        open(os.path.join(d, "appendix.md"), "w", encoding="utf-8").write(strip_fence(apx) + "\n")
        models[m] = models.get(m, 0) + 1
    except Exception as e:
        log(jid, f"appendix failed: {e}")
    update(jid, models2=models, elapsed2=time.time() - t0, progress=1)


# ---------------- runner ----------------
def run_job(jid, what="full"):
    d = jdir(jid); j = load(jid); t0 = time.time()
    try:
        if what == "full":
            src = os.path.join(d, j["file"]) if j.get("file") else download(jid, j["url"])
            audio, dur = to_audio(jid, src)
            update(jid, status="sources", message="קורא את דף המקורות…") if (j.get("sources_files") or j.get("sources_text")) else None
            ref = extract_sources(jid)
            segs = stage1(jid, audio, dur, ref)
        else:
            ref = open(os.path.join(d, "sources.txt"), encoding="utf-8").read() if os.path.exists(os.path.join(d, "sources.txt")) else ""
            segs = json.load(open(os.path.join(d, "raw.json"), encoding="utf-8"))
        try:
            stage2(jid, segs, ref)
            update(jid, status="done", message="התמלול מוכן", error=None, stage2_error=None, finished=now(), took=time.time() - t0)
        except Exception as e:
            log(jid, "stage2 failed: " + traceback.format_exc()[-1500:])
            update(jid, status="done", message="התמלול הראשוני מוכן, אבל שלב העריכה נכשל",
                   stage2_error=str(e)[:300], finished=now(), took=time.time() - t0)
    except Exception as e:
        log(jid, "failed: " + traceback.format_exc()[-2000:])
        update(jid, status="error", error=str(e)[:400], message="נכשל")


def _worker():
    while True:
        jid, what = _q.get()
        try: run_job(jid, what)
        except Exception: traceback.print_exc()
        finally: _q.task_done()


def enqueue(jid, what="full"):
    update(jid, status="queued", message="ממתין בתור…", queued_at=now())
    _q.put((jid, what))


def queue_position(jid):
    with _q.mutex:
        ids = [i for i, _ in list(_q.queue)]
    return ids.index(jid) + 1 if jid in ids else 0


def cleanup():
    """Delete jobs (audio, transcripts) older than KEEP_DAYS."""
    lim = time.time() - KEEP_DAYS * 86400
    for p in glob.glob(os.path.join(JOBS, "*", "job.json")):
        if os.path.getmtime(p) < lim:
            shutil.rmtree(os.path.dirname(p), ignore_errors=True)


def start(workers=2):
    for _ in range(workers):
        threading.Thread(target=_worker, daemon=True).start()
    cleanup()
    for j in sorted(all_jobs(), key=lambda j: j.get("created", "")):
        st = j.get("status")
        if st in ("queued", "downloading", "converting", "sources", "transcribing"):
            if j.get("file") and not os.path.exists(os.path.join(JOBS, j["id"], j["file"])) and not os.path.exists(os.path.join(JOBS, j["id"], "audio.mp3")):
                update(j["id"], status="error", error="השרת הופעל מחדש באמצע; נסו שוב"); continue
            if not j.get("file") and os.path.exists(os.path.join(JOBS, j["id"], "audio.mp3")):
                update(j["id"], file="audio.mp3")
            enqueue(j["id"], "full")
        elif st == "correcting":
            enqueue(j["id"], "correct" if j.get("raw_ready") else "full")
