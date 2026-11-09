"""תמלול – public web API + the same static UI. Bind to 127.0.0.1 behind a tunnel.
No endpoint lists jobs; each job is reachable only by its unguessable id."""
import collections, os, re, secrets, shutil, threading, time
from typing import List, Optional
from urllib.parse import quote
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from . import gemini, pipeline as P

VERSION = "2.0"
WEB = os.path.join(os.path.dirname(P.ROOT), "docs")
UPLOADS = os.path.join(P.DATA, "uploads")
os.makedirs(UPLOADS, exist_ok=True)
MEDIA_EXT = {".mp3", ".wav", ".m4a", ".mp4", ".webm", ".ogg", ".oga", ".opus", ".flac", ".aac", ".mkv", ".mov", ".wma",
             ".amr", ".3gp", ".m4v", ".avi", ".mpeg", ".mpg"}
SRC_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".txt", ".md", ".docx"}
MAX_UPLOAD = 2 * 1024 ** 3          # media file, sent in pieces (Cloudflare caps one request at 100MB)
MAX_PIECE = 40 * 1024 * 1024
MAX_SOURCES = 25 * 1024 * 1024      # all source files of one job
ORIGINS = [o for o in os.environ.get("TIMLUL_ORIGINS", "https://moshekfir78.github.io").split(",") if o]

app = FastAPI(title="תמלול", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS + ["http://localhost:8795", "http://127.0.0.1:8795"],
                   allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"], max_age=3600)

# ---------- light per-IP rate limiting ----------
_hits = collections.defaultdict(collections.deque)
_rl = threading.Lock()
LIMITS = {"job": (6, 3600), "upload": (400, 3600), "write": (120, 3600), "read": (1200, 600)}


def client_ip(req: Request):
    # the app listens on 127.0.0.1 only, so the tunnel's header is the real client address
    return req.headers.get("cf-connecting-ip") or (req.client.host if req.client else "?")


def limit(req: Request, kind: str):
    n, win = LIMITS[kind]; k = (client_ip(req), kind); t = time.time()
    with _rl:
        q = _hits[k]
        while q and q[0] < t - win: q.popleft()
        if len(q) >= n:
            raise HTTPException(429, "יותר מדי בקשות מהכתובת שלך. נסו שוב מאוחר יותר.")
        q.append(t)


def active_jobs_for(ip):
    return sum(1 for j in P.all_jobs() if j.get("ip") == ip and j.get("status") not in ("done", "error"))


def safe_name(n):
    n = os.path.basename(n or "file")
    n = re.sub(r"[^\w.\- א-ת()]", "_", n).strip(" .") or "file"
    return n[-100:]


PUBLIC_KEYS = ("id", "created", "updated", "status", "stage", "progress", "title", "url", "original_name", "message", "error",
               "stage2_error", "duration", "pieces", "eta", "elapsed1", "elapsed2", "models1", "models2", "raw_ready",
               "corrected_ready", "corrected_edited", "sources_notes", "sources_chars", "finished", "took")


def public(j):
    out = {k: j.get(k) for k in PUBLIC_KEYS if k in j}
    out["queue_position"] = P.queue_position(j["id"])
    return out


@app.on_event("startup")
def _start():
    P.start()
    def janitor():
        while True:
            time.sleep(3600)
            P.cleanup()
            for d in os.listdir(UPLOADS):        # abandoned partial uploads
                p = os.path.join(UPLOADS, d)
                if os.path.getmtime(p) < time.time() - 6 * 3600: shutil.rmtree(p, ignore_errors=True)
    threading.Thread(target=janitor, daemon=True).start()


@app.get("/api/health")
def health():
    return {"ok": True, "app": "timlul", "version": VERSION, "engine": "Gemini 3.5", "ready": bool(gemini.key()),
            "busy": P._q.qsize()}


# ---------- chunked media upload ----------
@app.post("/api/uploads")
def new_upload(req: Request, body: dict = Body(...)):
    limit(req, "upload")
    name = str(body.get("name", "")); size = int(body.get("size") or 0)
    ext = os.path.splitext(name)[1].lower()
    if ext not in MEDIA_EXT:
        raise HTTPException(400, "סוג הקובץ לא נתמך. אפשר להעלות קובץ שמע או וידאו (mp3, m4a, wav, mp4 ועוד).")
    if size <= 0 or size > MAX_UPLOAD:
        raise HTTPException(400, "הקובץ גדול מדי (עד 2GB).")
    uid = secrets.token_urlsafe(18)
    d = os.path.join(UPLOADS, uid); os.makedirs(d)
    open(os.path.join(d, "meta"), "w", encoding="utf-8").write(f"{size}\n{ext}\n{safe_name(name)}")
    open(os.path.join(d, "data"), "wb").close()
    return {"upload_id": uid, "piece": 32 * 1024 * 1024}


def _upload(uid):
    if not P.ID_RE.fullmatch(uid or ""):
        raise HTTPException(404, "ההעלאה לא נמצאה")
    d = os.path.join(UPLOADS, uid)
    if not os.path.isdir(d):
        raise HTTPException(404, "ההעלאה לא נמצאה")
    size, ext, name = open(os.path.join(d, "meta"), encoding="utf-8").read().split("\n", 2)
    return d, int(size), ext, name


@app.put("/api/uploads/{uid}")
async def put_piece(uid: str, req: Request, offset: int = 0):
    limit(req, "upload")
    d, size, _, _ = _upload(uid)
    p = os.path.join(d, "data"); cur = os.path.getsize(p)
    if offset != cur:
        return JSONResponse({"received": cur}, status_code=409)
    n = 0
    with open(p, "ab") as f:
        async for b in req.stream():
            n += len(b)
            if n > MAX_PIECE or cur + n > size:
                f.truncate(cur); raise HTTPException(400, "חלק ההעלאה גדול מדי")
            f.write(b)
    return {"received": cur + n}


# ---------- jobs ----------
@app.post("/api/jobs")
async def create_job(req: Request, url: str = Form(""), upload_id: str = Form(""), title: str = Form(""),
                     sources_text: str = Form(""), file: Optional[UploadFile] = File(None),
                     sources: List[UploadFile] = File(default=[])):
    ip = client_ip(req)
    url = (url or "").strip()
    has_file = bool(upload_id) or (file is not None and file.filename)
    if not has_file and not url:
        raise HTTPException(400, "יש להדביק קישור לשיעור או לבחור קובץ שמע/וידאו.")
    if url and not has_file and not re.match(r"^https?://[^\s/]+\.[^\s]+$", url):
        raise HTTPException(400, "הקישור לא נראה תקין. הוא צריך להתחיל ב-https://")
    if len(sources_text) > 200000:
        raise HTTPException(400, "טקסט המקורות ארוך מדי.")
    if active_jobs_for(ip) >= 2:
        raise HTTPException(429, "כבר יש לך שני תמלולים שרצים. חכו שאחד מהם יסתיים.")
    limit(req, "job")
    jid = secrets.token_urlsafe(18)
    d = os.path.join(P.JOBS, jid); os.makedirs(os.path.join(d, "sources"))
    job = {"id": jid, "created": P.now(), "updated": P.now(), "status": "queued", "stage": 1, "progress": 0, "ip": ip,
           "title": title.strip()[:200], "title_set": bool(title.strip()), "url": "" if has_file else url, "file": None,
           "sources_files": [], "sources_text": sources_text.strip(), "message": "ממתין בתור…"}
    try:
        if upload_id:
            ud, size, ext, name = _upload(upload_id)
            if os.path.getsize(os.path.join(ud, "data")) != size:
                raise HTTPException(400, "העלאת הקובץ לא הושלמה. נסו שוב.")
            shutil.move(os.path.join(ud, "data"), os.path.join(d, "source" + ext)); shutil.rmtree(ud, ignore_errors=True)
            job["file"] = "source" + ext; job["original_name"] = name
        elif file is not None and file.filename:
            ext = os.path.splitext(file.filename)[1].lower()
            if ext not in MEDIA_EXT:
                raise HTTPException(400, "סוג הקובץ לא נתמך.")
            with open(os.path.join(d, "source" + ext), "wb") as o:
                shutil.copyfileobj(file.file, o, 1 << 20)
            job["file"] = "source" + ext; job["original_name"] = safe_name(file.filename)
        if job.get("original_name") and not job["title"]:
            job["title"] = os.path.splitext(job["original_name"])[0]
        total = 0
        for s in sources or []:
            if not s or not s.filename: continue
            ext = os.path.splitext(s.filename)[1].lower()
            if ext not in SRC_EXT:
                raise HTTPException(400, f"סוג קובץ מקורות לא נתמך: {safe_name(s.filename)}. אפשר PDF, תמונה, Word או טקסט.")
            n = safe_name(s.filename)
            with open(os.path.join(d, "sources", n), "wb") as o:
                shutil.copyfileobj(s.file, o, 1 << 20)
            total += os.path.getsize(os.path.join(d, "sources", n))
            if total > MAX_SOURCES:
                raise HTTPException(400, "קבצי המקורות גדולים מדי (עד 25MB יחד).")
            job["sources_files"].append(n)
    except HTTPException:
        shutil.rmtree(d, ignore_errors=True); raise
    if not job["title"]:
        job["title"] = "שיעור ללא שם"
    P.save(job)
    P.enqueue(jid)
    return public(P.load(jid))


def _job(req, jid):
    limit(req, "read")
    try:
        return P.load(jid)
    except (KeyError, FileNotFoundError, OSError):
        raise HTTPException(404, "התמלול לא נמצא (ייתכן שנמחק או שעברו 14 יום)")


def _read(jid, name):
    p = os.path.join(P.jdir(jid), name)
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


@app.get("/api/jobs/{jid}")
def job(jid: str, req: Request):
    return public(_job(req, jid))


@app.get("/api/jobs/{jid}/result")
def result(jid: str, req: Request):
    j = _job(req, jid)
    import json
    rp = os.path.join(P.jdir(jid), "raw.json")
    raw = json.load(open(rp, encoding="utf-8")) if os.path.exists(rp) else []
    return {"job": public(j), "raw": raw, "corrected": _read(jid, "corrected.md"),
            "appendix": _read(jid, "appendix.md"), "sources": _read(jid, "sources.txt")[:200000]}


@app.put("/api/jobs/{jid}/corrected")
def save_corrected(jid: str, req: Request, body: dict = Body(...)):
    _job(req, jid); limit(req, "write"); d = P.jdir(jid)
    text = str(body.get("text", ""))
    if len(text) > 2_000_000:
        raise HTTPException(400, "הטקסט ארוך מדי")
    p = os.path.join(d, "corrected.md")
    if os.path.exists(p) and not os.path.exists(os.path.join(d, "corrected.orig.md")):
        shutil.copy(p, os.path.join(d, "corrected.orig.md"))
    open(p, "w", encoding="utf-8").write(text)
    P.update(jid, corrected_ready=True, corrected_edited=True)
    return {"ok": True}


@app.post("/api/jobs/{jid}/correct")
def recorrect(jid: str, req: Request):
    j = _job(req, jid); limit(req, "job")
    if not j.get("raw_ready"):
        raise HTTPException(409, "התמלול הראשוני עוד לא מוכן")
    if j.get("status") not in ("done", "error"):
        raise HTTPException(409, "התמלול עדיין רץ")
    P.update(jid, error=None, stage2_error=None)
    P.enqueue(jid, "correct")
    return public(P.load(jid))


@app.delete("/api/jobs/{jid}")
def delete(jid: str, req: Request):
    j = _job(req, jid); limit(req, "write")
    if j.get("status") not in ("done", "error"):
        raise HTTPException(409, "אי אפשר למחוק תמלול שעדיין רץ")
    shutil.rmtree(P.jdir(jid), ignore_errors=True)
    return {"ok": True}


def md_to_txt(md):
    out = []
    for ln in md.splitlines():
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", ln)
        s = re.sub(r"^#+\s*", "", s)
        if s.lstrip().startswith(">"):
            s = "        " + s.lstrip()[1:].lstrip()
        out.append(s)
    return "\n".join(out).strip() + "\n"


@app.get("/api/jobs/{jid}/download")
def download(jid: str, req: Request, kind: str = "corrected", fmt: str = "md", stamps: int = 1):
    j = _job(req, jid)
    title = j.get("title") or "תמלול"
    if kind == "raw":
        import json
        rp = os.path.join(P.jdir(jid), "raw.json")
        segs = json.load(open(rp, encoding="utf-8")) if os.path.exists(rp) else []
        body = "\n\n".join((f"{P.ts(s['start'])} " if stamps else "") + s["text"] for s in segs) + "\n"
        if fmt == "md": body = f"# {title} – תמלול ראשוני\n\n" + body
    else:
        md = _read(jid, "corrected.md")
        apx = _read(jid, "appendix.md")
        if apx.strip(): md = md.rstrip() + "\n\n" + apx
        if not stamps:
            md = re.sub(r"(?m)^(\s*(?:>\s*)?)\[\d{1,2}:\d{2}(?::\d{2})?\]\s*", r"\1", md)
        body = f"# {title}\n\n{md}" if fmt == "md" else title + "\n\n" + md_to_txt(md)
    base = re.sub(r"[\\/:*?\"<>|]+", "_", title)[:80].strip() or "timlul"
    name = f"{base} - {'ראשוני' if kind == 'raw' else 'תמלול'}.{'md' if fmt == 'md' else 'txt'}"
    return Response(body.encode("utf-8"), media_type=("text/markdown" if fmt == "md" else "text/plain") + "; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}", "Cache-Control": "no-store"})


# ---------- static UI (same files as GitHub Pages) ----------
@app.get("/config.json")
def config():
    return JSONResponse({"api": ""}, headers={"Cache-Control": "no-store"})   # same origin when opened through the tunnel


@app.get("/")
def index():
    return FileResponse(os.path.join(WEB, "index.html"))


app.mount("/", StaticFiles(directory=WEB), name="web")
