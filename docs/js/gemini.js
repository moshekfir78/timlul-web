/* Gemini REST client – runs in the browser. The key is passed in by the caller (from localStorage)
   and is only ever sent to generativelanguage.googleapis.com in the x-goog-api-key header. */
export const API = "https://generativelanguage.googleapis.com/v1beta";

// Stage 1 (audio -> raw text): the dedicated Gemini 3.5 transcription model first, then multimodal flash models.
export const TRANSCRIBE_PREF = ["gemini-3.5-transcribe", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-3.8-flash", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
// Stage 2 (raw text + sources -> edited transcript) and OCR of sources.
export const CORRECT_PREF = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash",
  "gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

export class GeminiError extends Error {
  constructor(msg, status = 0, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); }
}

const sleep = (ms, signal) => new Promise((ok, no) => {
  if (signal?.aborted) return no(signal.reason || new DOMException("aborted", "AbortError"));
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); no(signal.reason || new DOMException("aborted", "AbortError")); }, { once: true });
});
export const isAbort = (e) => e?.name === "AbortError";

/** fetch with our own timeout that also follows the caller's AbortSignal */
async function req(key, method, path, body, { signal, timeoutMs = 600000 } = {}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) throw new DOMException("aborted", "AbortError"); signal.addEventListener("abort", onAbort, { once: true }); }
  const t = setTimeout(() => ctl.abort(new GeminiError("timeout", 0, { kind: "timeout" })), timeoutMs);
  let r;
  try {
    r = await fetch(API + path, {
      method, signal: ctl.signal, referrerPolicy: "no-referrer", credentials: "omit",
      headers: { "x-goog-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (ctl.signal.aborted) throw new GeminiError("timeout", 0, { kind: "timeout" });
    throw new GeminiError("network", 0, { kind: "network" });
  } finally { clearTimeout(t); signal?.removeEventListener("abort", onAbort); }
  if (r.ok) return r.json();
  let j = {}; try { j = await r.json(); } catch {}
  const e = j.error || {}; const det = e.details || [];
  const reason = (det.find((d) => d.reason) || {}).reason || "";
  const retry = (det.find((d) => d.retryDelay) || {}).retryDelay;   // e.g. "37s"
  const viol = det.filter((d) => d.violations).flatMap((d) => d.violations);
  const quota = viol.map((v) => v.quotaId || "").join(",");
  const perMin = viol.find((v) => /PerMinute/i.test(v.quotaId || "")), perDay = viol.find((v) => /PerDay/i.test(v.quotaId || ""));
  throw new GeminiError(`${r.status} ${(e.message || "").slice(0, 200)}`.trim(), r.status,
    { reason, retryMs: retry ? parseFloat(retry) * 1000 : 0, quota, apiStatus: e.status || "",
      rpm: perMin ? parseInt(perMin.quotaValue, 10) || 0 : 0, daily: !!perDay, free: /FreeTier/i.test(quota) });
}

export function isKeyError(e) {
  return e instanceof GeminiError && (e.reason === "API_KEY_INVALID" || e.status === 401 || e.status === 403 ||
    (e.status === 400 && /api key/i.test(e.message)));
}

/** Hebrew, user-facing explanation of an API error */
export function heError(e) {
  if (isAbort(e)) return "התמלול בוטל.";
  if (!(e instanceof GeminiError)) return e?.message || String(e);
  if (isKeyError(e)) return e.status === 403 ? "למפתח ה-Gemini אין הרשאה לשירות הזה. ודאו שיצרתם אותו ב-Google AI Studio." : "מפתח ה-Gemini לא תקין. בדקו אותו בהגדרות (העתיקו אותו שוב מ-Google AI Studio).";
  if (e.status === 429) return "הגעתם למגבלת השימוש החינמית של Gemini לעכשיו. נסו שוב בעוד כמה דקות (או מחר, אם זו המגבלה היומית).";
  if (e.kind === "network") return "אין חיבור ל-Gemini. בדקו את החיבור לאינטרנט ונסו שוב.";
  if (e.kind === "timeout") return "Gemini לא ענה בזמן. נסו שוב.";
  if (e.status >= 500) return "שירות Gemini עמוס כרגע. נסו שוב בעוד כמה דקות.";
  return "Gemini החזיר שגיאה: " + e.message;
}

// ---------------- models ----------------
const _models = new Map();   // key -> Promise<Set<string>>
export function listModels(key, { signal, fresh } = {}) {
  if (fresh || !_models.has(key)) {
    const p = (async () => {
      const out = new Set(); let page = "";
      do {
        const j = await req(key, "GET", `/models?pageSize=1000${page ? "&pageToken=" + encodeURIComponent(page) : ""}`, null, { signal, timeoutMs: 30000 });
        for (const m of j.models || []) if ((m.supportedGenerationMethods || []).includes("generateContent")) out.add(m.name.split("/").pop());
        page = j.nextPageToken || "";
      } while (page);
      return out;
    })();
    _models.set(key, p);
    p.catch(() => _models.delete(key));
  }
  return _models.get(key);
}

export async function cascade(key, pref, signal) {
  let names;
  try { names = await listModels(key, { signal }); } catch (e) { if (isKeyError(e) || isAbort(e)) throw e; return [...pref]; }
  const out = pref.filter((m) => names.has(m));
  if (out.length) return out;
  return [...names].filter((n) => /^gemini-3(\.\d+)?-flash(-preview)?$/.test(n)).sort().reverse().slice(0, 3);
}

/** Validate a key: returns {ok:true, transcribe:boolean} or throws GeminiError */
export async function checkKey(key) {
  const names = await listModels(key, { fresh: true });
  return { ok: true, transcribe: names.has("gemini-3.5-transcribe"), flash: names.has("gemini-3.5-flash"), count: names.size };
}

// ---------------- generate ----------------
function textOf(cand) {
  const out = [];
  for (const p of cand?.content?.parts || []) {
    if (p.thought) continue;
    if (p.text) out.push(p.text);
    else if (p.audioTranscription && typeof p.audioTranscription === "object") out.push(p.audioTranscription.text || "");  // gemini-3.5-transcribe
  }
  return out.join("");
}

// model -> time until which it's skipped (missing model / out of daily quota). Daily limits are remembered on this device.
const COOL = "timlul.cool.v1";
const cool = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(COOL)) || {}; } catch { return {}; } })()));
function setCool(m, until, persist) {
  cool.set(m, until);
  if (persist) { try { const o = {}; for (const [k, v] of cool) if (v > Date.now()) o[k] = v; localStorage.setItem(COOL, JSON.stringify(o)); } catch {} }
}
export function clearCool() { cool.clear(); try { localStorage.removeItem(COOL); } catch {} }
export function freeTierSeen() { try { return localStorage.getItem("timlul.freeTier") === "1"; } catch { return false; } }

// per-model requests-per-minute pacing, learned from 429 answers (free tier: as low as 3/min)
const rpm = new Map(), starts = new Map();
async function slot(m, signal) {
  for (;;) {
    const lim = rpm.get(m); if (!lim) break;
    const now = Date.now(), st = (starts.get(m) || []).filter((t) => now - t < 61000); starts.set(m, st);
    if (st.length < lim) break;
    await sleep(st[0] + 61000 - now + 200, signal);
  }
  const st = starts.get(m) || []; st.push(Date.now()); starts.set(m, st);
}

/**
 * Try models in order with retries. Returns {text, model}.
 * parts: Gemini parts. textParts: extra text parts sent to non-transcribe models only.
 */
export async function generate(key, { parts, textParts = [], pref, maxTokens = 65536, thinking = "low", tries = 3,
  timeoutMs = 600000, signal, log = () => {}, onWait, accept } = {}) {
  const errs = []; let last = null;
  const models = await cascade(key, pref, signal);
  const live = models.filter((m) => (cool.get(m) || 0) < Date.now());
  for (const m of (live.length ? live : models)) {
    const transcribe = m.endsWith("-transcribe");
    const gc = { temperature: 0 };
    if (!transcribe) {
      gc.maxOutputTokens = maxTokens;
      if (thinking && /^gemini-3|^gemini-(flash|pro)-latest/.test(m)) gc.thinkingConfig = { thinkingLevel: thinking };
    }
    const body = { contents: [{ role: "user", parts: transcribe ? parts : [...parts, ...textParts] }], generationConfig: gc };
    let rate = 0;
    for (let attempt = 0; attempt < tries + rate; attempt++) {
      try {
        await slot(m, signal);
        log(`${m} (ניסיון ${attempt + 1})`);
        const j = await req(key, "POST", `/models/${m}:generateContent`, body, { signal, timeoutMs });
        const c = (j.candidates || [])[0];
        const out = textOf(c);
        if (out.trim() && accept && !accept(out)) { errs.push(`${m}:פלט פגום`); log(`${m}: פלט פגום – עובר למודל הבא`); break; }
        if (out.trim()) { if (errs.length) log("מעברים: " + errs.join(", ")); return { text: out, model: m }; }
        errs.push(`${m}:ריק(${c?.finishReason || j.promptFeedback?.blockReason || "?"})`);
        break;
      } catch (e) {
        if (isAbort(e) || isKeyError(e)) throw e;
        last = e;
        errs.push(`${m}:${e.status || e.kind}`);
        if (e.status === 429) {
          if (e.free) { try { localStorage.setItem("timlul.freeTier", "1"); } catch {} }
          if (e.daily) { setCool(m, Date.now() + Math.min(Math.max(e.retryMs || 0, 3600000), 26 * 3600000), true); log(`${m}: נגמרה המכסה היומית`); break; }
          if (e.rpm) rpm.set(m, Math.max(1, e.rpm));
          if (rate >= 6) { setCool(m, Date.now() + 10 * 60000); break; }
          rate++;
          const wait = Math.min(Math.max(e.retryMs || 0, 6000 * rate), 65000);
          onWait?.(wait); await sleep(wait + Math.random() * 1500, signal); continue;
        }
        if (e.status === 404) { setCool(m, Date.now() + 6 * 3600000); break; }
        if ((e.status >= 500 || e.kind === "network" || e.kind === "timeout") && attempt < tries - 1 + rate) {
          await sleep(3000 + 6000 * attempt + Math.random() * 1000, signal); continue;
        }
        break;
      }
    }
  }
  const err = new GeminiError("Gemini לא זמין כרגע (" + errs.slice(-6).join(", ") + ")", last?.status || 0, { kind: last?.kind });
  throw err;
}

/** Files API (for pieces too big to send inline). Returns {name, uri, mime}. */
export async function uploadFile(key, blob, mime, { signal } = {}) {
  const start = await fetch(API.replace("/v1beta", "/upload/v1beta") + "/files", {
    method: "POST", signal, referrerPolicy: "no-referrer", credentials: "omit",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(blob.size), "X-Goog-Upload-Header-Content-Type": mime },
    body: JSON.stringify({ file: { display_name: "timlul-piece" } }),
  }).catch((e) => { if (signal?.aborted) throw new DOMException("aborted", "AbortError"); throw new GeminiError("network", 0, { kind: "network" }); });
  if (!start.ok) throw new GeminiError(`${start.status} upload start`, start.status);
  const url = start.headers.get("x-goog-upload-url"); if (!url) throw new GeminiError("upload url missing", 0);
  const up = await fetch(url, { method: "POST", signal, credentials: "omit", headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" }, body: blob })
    .catch((e) => { if (signal?.aborted) throw new DOMException("aborted", "AbortError"); throw new GeminiError("network", 0, { kind: "network" }); });
  if (!up.ok) throw new GeminiError(`${up.status} upload`, up.status);
  let f = (await up.json()).file;
  for (let i = 0; f.state === "PROCESSING" && i < 60; i++) { await sleep(2000, signal); f = await req(key, "GET", "/" + f.name, null, { signal, timeoutMs: 30000 }); }
  if (f.state === "FAILED") throw new GeminiError("file processing failed", 0);
  return { name: f.name, uri: f.uri, mime: f.mimeType || mime };
}
export function deleteFile(key, name) { return req(key, "DELETE", "/" + name, null, { timeoutMs: 30000 }).catch(() => {}); }
export function fileData(f) { return { file_data: { mime_type: f.mime, file_uri: f.uri } }; }

export function inline(base64, mime) { return { inline_data: { mime_type: mime, data: base64 } }; }

export function blobToBase64(blob) {
  return new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); ok(s.slice(s.indexOf(",") + 1)); };
    fr.onerror = () => no(fr.error);
    fr.readAsDataURL(blob);
  });
}
