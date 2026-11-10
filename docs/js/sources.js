/* Sources page (דף מקורות): extract text in the browser. txt/md directly, docx via mammoth,
   PDF via pdf.js (scanned / visually-ordered PDFs and images go to Gemini for OCR). */
import { generate, inline, blobToBase64, CORRECT_PREF } from "./gemini.js";
import { OCR } from "./prompts.js";
import { loadScript } from "./audio.js";

const IMG = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
const TEXT = new Set(["txt", "md", "markdown", "text"]);
const FINALS = "ךםןףץ";
export const SRC_RE = /\.(pdf|png|jpe?g|webp|gif|heic|heif|txt|md|markdown|text|docx)$/i;

const he = (t) => (t.match(/[א-ת]/g) || []).length;
function reversed(t) {   // visually-ordered Hebrew: final letters show up at word starts
  const w = t.match(/[א-ת]{2,}/g) || [];
  const s = w.filter((x) => FINALS.includes(x[0])).length, e = w.filter((x) => FINALS.includes(x[x.length - 1])).length;
  return s > e && s > 5;
}
async function ocr(key, file, mime, signal, log) {
  const b64 = await blobToBase64(file);
  const { text, model } = await generate(key, { parts: [inline(b64, mime), { text: OCR }], pref: CORRECT_PREF, maxTokens: 32768, signal, log });
  log(`OCR: ${model}`);
  return text.trim();
}
function garbled(t) {    // broken font maps (common with nikud): control characters or words split into single letters
  const ctrl = (t.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) || []).length;
  const toks = t.match(/[\u0590-\u05ff]+/g) || [], single = toks.filter((w) => w.replace(/[\u0591-\u05c7]/g, "").length === 1).length;
  return ctrl > 3 || (toks.length > 20 && single / toks.length > 0.3);
}
let pdfjs = null;
async function pdfText(file) {
  if (!pdfjs) { pdfjs = await import("../vendor/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= Math.min(doc.numPages, 200); p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    let s = ""; for (const it of tc.items) { s += it.str || ""; if (it.hasEOL) s += "\n"; else if (it.str && !/\s$/.test(it.str)) s += " "; }
    pages.push(s);
  }
  const n = doc.numPages; await doc.destroy();
  return { text: pages.join("\n\n"), pages: n };
}

/** returns {text, note} – note is a short Hebrew status for the UI */
export async function extractFile(key, file, { signal, log = () => {} } = {}) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (TEXT.has(ext)) return { text: (await file.text()).trim(), note: "טקסט" };
  if (ext === "docx") {
    await loadScript("vendor/mammoth.browser.min.js");
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: r.value.replace(/\n{3,}/g, "\n\n").trim(), note: "Word" };
  }
  if (IMG[ext]) {
    try { return { text: await ocr(key, file, IMG[ext], signal, log), note: "תמונה (זיהוי Gemini)" }; }
    catch (e) { if (e.name === "AbortError") throw e; return { text: "", note: "תמונה – זיהוי הטקסט נכשל" }; }
  }
  if (ext === "pdf") {
    let txt = "", pages = 1;
    try { ({ text: txt, pages } = await pdfText(file)); } catch (e) { log("pdf.js: " + e.message); }
    const scanned = he(txt) < 80 * pages * 0.3 || reversed(txt) || garbled(txt);
    if (scanned && file.size < 19 * 1024 * 1024) {
      try { return { text: await ocr(key, file, "application/pdf", signal, log), note: "PDF (זיהוי Gemini)" }; }
      catch (e) { if (e.name === "AbortError") throw e; if (!txt.trim()) return { text: "", note: "PDF סרוק – זיהוי הטקסט נכשל" }; }
    }
    if (reversed(txt)) txt = txt.split("\n").map((l) => [...l].reverse().join("")).join("\n");
    return { text: txt.replace(/\n{3,}/g, "\n\n").trim(), note: "PDF" };
  }
  try { return { text: (await file.text()).trim(), note: "טקסט" }; } catch { return { text: "", note: "סוג קובץ לא נתמך" }; }
}
