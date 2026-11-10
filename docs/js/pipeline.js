/* The whole job, in the browser:
   sources -> decode + cut audio -> stage 1 (gemini-3.5-transcribe, ~2-minute pieces, 5 in parallel)
   -> stage 2 (gemini-3.5-flash editing pass with the sources page, ~30-minute pieces) -> appendix. */
import { generate, inline, blobToBase64, uploadFile, deleteFile, fileData, TRANSCRIBE_PREF, CORRECT_PREF, isKeyError, isAbort, GeminiError } from "./gemini.js";
import { RAW, CORRECT, APPENDIX, fill } from "./prompts.js";
import { chunkFile, PIECE } from "./audio.js";
import { extractFile } from "./sources.js";

export const PIECE_PAR = 5;
/** Reject degenerate transcriptions (e.g. "b b b b …", one word looping, almost no Hebrew). */
export function plausible(text, secs) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  const words = t.split(" ");
  let run = 1, maxRun = 1;
  for (let i = 1; i < words.length; i++) { run = words[i] === words[i - 1] ? run + 1 : 1; if (run > maxRun) maxRun = run; }
  if (maxRun >= 12) return false;
  if (words.length > 60 && new Set(words).size / words.length < 0.12) return false;
  const heb = (t.match(/[\u05d0-\u05ea]/g) || []).length, lat = (t.match(/[A-Za-z]/g) || []).length;
  if (t.length > 120 && heb < lat) return false;
  if (secs > 60 && heb < secs * 0.25 && !/^\(?[^)]*\)?$/.test(t)) return false;   // far too little text for the audio length
  return true;
}
const INLINE_MAX = 10 * 1024 * 1024;   // bigger pieces go through the Files API (inline requests are capped at 20MB)
/** Piece length: ~2 minutes for short recordings; for long ones aim at ~8 calls, because the free tier
    allows only a few dozen transcription calls a day (and 3 a minute). */
export function pieceFor(dur) { return dur <= 16 * 60 ? PIECE : Math.min(900, Math.max(PIECE, Math.ceil(dur / 8))); }

/** Split a long piece's text into ~2-minute lines, timing them in proportion to the text (approximate timestamps). */
export function splitPiece(start, end, text, step = PIECE) {
  const dur = end - start, n = Math.round(dur / step);
  if (n < 2 || text.length < 200) return [{ start, end, text }];
  const L = text.length, cuts = [0];
  for (let k = 1; k < n; k++) {
    const target = Math.round(L * k / n), w = Math.round(L / n * 0.2);
    let best = -1;
    for (let d = 0; d <= w && best < 0; d++) for (const i of [target + d, target - d]) if (i > cuts[cuts.length - 1] + 20 && i < L - 20 && /[.?!:]/.test(text[i - 1]) && text[i] === " ") { best = i; break; }
    if (best < 0) { best = text.indexOf(" ", target); if (best < 0 || best <= cuts[cuts.length - 1]) continue; }
    cuts.push(best);
  }
  cuts.push(L);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t = text.slice(cuts[i], cuts[i + 1]).trim(); if (!t) continue;
    out.push({ start: start + dur * cuts[i] / L, end: start + dur * cuts[i + 1] / L, text: t, approx: i > 0 });
  }
  return out;
}
export const CHUNK = 30 * 60;
const sleep = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(t); no(new DOMException("aborted", "AbortError")); }, { once: true }); });

export function ts(x) {
  x = Math.floor(x); const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), s = x % 60;
  return h ? `[${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]` : `[${m}:${String(s).padStart(2, "0")}]`;
}
const stripFence = (t) => t.trim().replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
/** drop a heading/preamble the model sometimes adds before the first timestamped paragraph */
function stripPreamble(t) {
  const lines = t.split("\n"); let i = 0;
  while (i < lines.length && i < 4) {
    const l = lines[i].trim();
    if (!l) { i++; continue; }
    if (/^\[\d/.test(l) || /^>/.test(l)) break;
    if (l.length < 140 && (/^#/.test(l) || /חלק \d+ מתוך \d+/.test(l) || /^\*\*[^*]+\*\*$/.test(l) || /^(תמלול|עריכת)/.test(l))) { i++; continue; }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/** Small semaphore so the decoder waits while PIECE_PAR pieces are in flight (bounded memory). */
function pool(n) {
  let free = n; const waiters = [];
  return {
    acquire: () => free > 0 ? (free--, Promise.resolve()) : new Promise((ok) => waiters.push(ok)),
    release: () => { const w = waiters.shift(); if (w) w(); else free++; },
  };
}

export async function extractSources(key, job, files, { signal, log }) {
  const parts = [], notes = [];
  if (job.sourcesText?.trim()) { parts.push(job.sourcesText.trim()); notes.push({ name: "טקסט שהודבק", note: "טקסט", chars: job.sourcesText.trim().length }); }
  for (const f of files) {
    let r;
    try { r = await extractFile(key, f, { signal, log }); }
    catch (e) { if (isAbort(e) || isKeyError(e)) throw e; r = { text: "", note: "לא הצלחתי לקרוא את הקובץ" }; log(`sources ${f.name}: ${e.message}`); }
    if (r.text) parts.push(`=== ${f.name} ===\n${r.text}`);
    notes.push({ name: f.name, note: r.note, chars: r.text.length });
  }
  return { text: parts.join("\n\n").trim(), notes };
}

/**
 * Stage 1. `update(patch)` merges into the job and re-renders/saves.
 */
export async function stage1(key, job, file, { signal, update, log }) {
  const ctl = new AbortController(); const sig = ctl.signal;
  const stop = () => ctl.abort(); signal.addEventListener("abort", stop, { once: true });
  const rawPrompt = fill(RAW, (job.sources || "").slice(0, 8000));
  const results = []; const models = {}; let doneSec = 0, duration = 0, decodeFrac = 0, fatal = null, failed = 0, total = 0, pieces = 0, plen = PIECE;
  const t0 = performance.now(); const sem = pool(PIECE_PAR); const tasks = [];
  const report = () => {
    const el = (performance.now() - t0) / 1000;
    const frac = duration ? Math.min(1, doneSec / duration) : 0;
    update({
      status: "transcribing", stage: 2, progress: frac, duration: duration || null, models1: { ...models },
      piecesDone: pieces, piecesTotal: Math.max(total, Math.round((duration || 0) / plen) || 0), decodeFrac,
      eta: doneSec > 30 ? el / doneSec * Math.max(0, duration - doneSec) : null, elapsed1: el,
      raw: results.slice().sort((a, b) => a.start - b.start),
    });
  };
  async function one(i, p) {
    let up = null;
    try {
      let parts, err, r;
      if (p.blob.size > INLINE_MAX) {
        for (let k = 0; k < 3 && !up; k++) {
          try { up = await uploadFile(key, p.blob, "audio/wav", { signal: sig }); }
          catch (e) { if (isAbort(e) || isKeyError(e)) throw e; err = e; log(`קטע ${i + 1}: העלאה נכשלה (${e.message})`); await sleep(4000 * (k + 1), sig); }
        }
        if (!up) throw err;
        parts = [fileData(up)];
      } else parts = [inline(await blobToBase64(p.blob), "audio/wav")];
      p.blob = null;
      for (let round = 0; round < 2 && !r; round++) {
        try {
          r = await generate(key, { parts, textParts: [{ text: rawPrompt }], pref: TRANSCRIBE_PREF, accept: (t) => plausible(t, p.end - p.start),
            maxTokens: 32768, tries: 4, timeoutMs: 600000, signal: sig, log: (m) => log(`קטע ${i + 1}: ${m}`) });
        } catch (e) {
          if (isAbort(e) || isKeyError(e)) throw e;
          err = e; log(`קטע ${i + 1} נכשל: ${e.message}`);
          if (round === 0) await sleep(20000, sig);
        }
      }
      const round2 = (x) => Math.round(x * 100) / 100;
      if (r) {
        const text = r.text.replace(/\s+/g, " ").trim(); models[r.model] = (models[r.model] || 0) + 1;
        for (const seg of splitPiece(p.start, p.end, text)) results.push({ start: round2(seg.start), end: round2(seg.end), text: seg.text, model: r.model, ...(seg.approx ? { approx: true } : {}) });
      } else {
        failed++;
        if (failed > Math.max(2, (total || 10) * 0.2)) throw err || new GeminiError("Gemini לא זמין");
        results.push({ start: round2(p.start), end: round2(p.end), text: "[?קטע זה לא תומלל – Gemini לא היה זמין?]", model: null, failed: true });
      }
      pieces++; doneSec += p.end - p.start; report();
    } catch (e) { if (!fatal) fatal = e; ctl.abort(); }
    finally { if (up) deleteFile(key, up.name); sem.release(); }
  }
  try {
    update({ status: "decoding", stage: 1, progress: 0, message: "" });
    duration = await chunkFile(file, {
      signal: sig, log, pieceFor: (d) => (plen = pieceFor(d)),
      onProgress: (f, d) => { decodeFrac = f; if (d) duration = d; if (!results.length) update({ status: total ? "transcribing" : "decoding", stage: total ? 2 : 1, decodeFrac: f, duration: duration || null }); },
      emit: async (p) => {
        await sem.acquire();
        if (sig.aborted) { sem.release(); throw new DOMException("aborted", "AbortError"); }
        const i = total++; tasks.push(one(i, p));
        if (i === 0) update({ status: "transcribing", stage: 2, progress: 0 });
      },
    });
  } catch (e) { if (!fatal) fatal = e; ctl.abort(); }
  await Promise.allSettled(tasks);
  signal.removeEventListener("abort", stop);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (fatal) { report(); throw fatal; }
  doneSec = duration; report();
  const segs = results.sort((a, b) => a.start - b.start);
  log(`שלב 1 הסתיים: ${segs.length} קטעים ב-${Math.round((performance.now() - t0) / 1000)} שניות, ${JSON.stringify(models)}`);
  update({ raw: segs, rawReady: true, pieceLen: plen, progress: 1, eta: 0, duration, failedPieces: failed, elapsed1: (performance.now() - t0) / 1000 });
  return segs;
}

export async function stage2(key, job, { signal, update, log }) {
  const segs = (job.raw || []).filter((s) => s.text && !s.failed);
  if (!segs.length) throw new Error("התמלול הראשוני ריק – אין מה לערוך");
  let base = fill(CORRECT, job.sources);
  if (job.title) base += `\nכותרת השיעור: ${job.title}\n`;
  base += "\nתזכורת חשובה: החזר רק את מה שמופיע בתמלול הגולמי, מתוקן. דף המקורות משמש רק לתיקון נוסח של מה שנאמר – אסור להוסיף ממנו ציטוטים, פסוקים או קטעים שלא מופיעים בתמלול. קטע שסומן כלא מתומלל או שהוא שאריות זבל – השמט בלי להשלים.\n";
  const chunks = [];
  for (const s of job.raw) {
    const off = Math.floor(s.start / CHUNK);
    if (!chunks.length || chunks[chunks.length - 1].off !== off) chunks.push({ off, lines: [] });
    chunks[chunks.length - 1].lines.push(`${ts(s.start)} ${s.text}`);
  }
  const n = chunks.length, outs = new Array(n), models = {}; let done = 0; const t0 = performance.now();
  update({ status: "correcting", stage: 3, progress: 0, piecesDone: 0, piecesTotal: n });
  const sem = pool(3); const ctl = new AbortController(); const stop = () => ctl.abort(); signal.addEventListener("abort", stop, { once: true });
  const outer = signal; signal = ctl.signal;
  try { await Promise.all(chunks.map(async (c, i) => {
    await sem.acquire();
    try {
      const pre = n === 1 ? "" : `(זהו חלק ${i + 1} מתוך ${n} של השיעור. ערוך רק את החלק הזה, בלי הקדמה ובלי נספחים.)\n\n`;
      const r = await generate(key, { parts: [{ text: base }, { text: pre + "התמלול הגולמי:\n\n" + c.lines.join("\n") }], pref: CORRECT_PREF,
        timeoutMs: 600000, signal, log: (m) => log(`עריכה ${i + 1}: ${m}`) });
      outs[i] = stripPreamble(stripFence(r.text)); models[r.model] = (models[r.model] || 0) + 1; done++;
      update({ progress: done / (n + 1), piecesDone: done, models2: { ...models } });
    } catch (e) { ctl.abort(); throw e; } finally { sem.release(); }
  })); } finally { outer.removeEventListener("abort", stop); }
  if (outer.aborted) throw new DOMException("aborted", "AbortError");
  const body = outs.join("\n\n");
  update({ corrected: body, correctedReady: true, message: "מכין נספח סיפורים ודף מקורות…" });
  try {
    const r = await generate(key, { parts: [{ text: fill(APPENDIX, job.sources) }, { text: body }], pref: CORRECT_PREF, maxTokens: 8192,
      timeoutMs: 300000, signal, log: (m) => log("נספח: " + m) });
    models[r.model] = (models[r.model] || 0) + 1;
    update({ appendix: stripFence(r.text) });
  } catch (e) { if (isAbort(e) || isKeyError(e)) throw e; log("הנספח נכשל: " + e.message); }
  update({ models2: { ...models }, elapsed2: (performance.now() - t0) / 1000, progress: 1 });
}
