/* תמלול – fully client-side app. No server: the user's own Gemini key (localStorage only) talks to Google directly. */
import { checkKey, heError, isAbort, isKeyError, GeminiError, clearCool } from "./gemini.js";
import { extractSources, stage1, stage2, ts } from "./pipeline.js";
import { SRC_RE } from "./sources.js";
import * as store from "./store.js";
import { toDocx, toTxt, stripTs } from "./export.js";

const $ = (s) => document.querySelector(s);
const KEY = "timlul.geminiKey";
const getKey = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
const minutes = (s) => { const m = Math.round((s || 0) / 60); return m < 1 ? "פחות מדקה" : m === 1 ? "דקה" : m === 2 ? "שתי דקות" : `${m} דקות`; };
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2800); }
const newId = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join(""); };
const safeName = (s) => (s || "תמלול").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "תמלול";
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

// ---------- markdown (safe: everything is escaped first) ----------
function inline(s) {
  s = esc(s);
  s = s.replace(/\[\?(.+?)\?\]/g, '<mark class="unsure" title="לא ודאי – כדאי לבדוק">$1</mark>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,:;])/g, "$1<em>$2</em>");
  s = s.replace(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/, '<span class="ts">$1</span>');
  return s;
}
function md(text) {
  const out = []; let para = [], quote = [], list = [];
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join(" ") + "</p>"); para = []; } };
  const flushQ = () => { if (quote.length) {
      const body = quote.map(inline).join("<br>").replace(/\s*(\([^()]{2,80}\))\s*$/, ' <span class="src">$1</span>');
      out.push("<blockquote><p>" + body + "</p></blockquote>"); quote = []; } };
  const flushL = () => { if (list.length) { out.push("<ul>" + list.map((l) => "<li>" + inline(l) + "</li>").join("") + "</ul>"); list = []; } };
  const flush = () => { flushP(); flushQ(); flushL(); };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    let m;
    if ((m = l.match(/^#{1,6}\s+(.*)$/))) { flush(); out.push("<h3>" + inline(m[1]) + "</h3>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushP(); flushL(); quote.push(m[1]); continue; }
    if ((m = l.match(/^[-•*]\s+(.*)$/))) { flushP(); flushQ(); list.push(m[1]); continue; }
    flushQ(); flushL(); para.push(l);
  }
  flush();
  return out.join("\n");
}

// ---------- key ----------
function syncKeyUi() {
  const k = getKey();
  $("#keyDot").classList.toggle("on", !!k);
  $("#keyState").textContent = k ? " (מוגדר)" : " (לא מוגדר)";
  $("#needKey").hidden = !!k;
  $("#keyDel").hidden = !k;
  if (k && !$("#keyInput").value) $("#keyInput").placeholder = "✓ מפתח שמור במכשיר – אפשר להדביק מפתח חדש להחלפה";
  else if (!k) $("#keyInput").placeholder = "AIza…";
}
$("#keyShow").addEventListener("click", () => {
  const i = $("#keyInput"), on = i.type === "password"; i.type = on ? "text" : "password";
  $("#keyShow").setAttribute("aria-pressed", String(on)); $("#keyShow").textContent = on ? "הסתרה" : "הצגה";
});
$("#keyForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const v = $("#keyInput").value.trim().replace(/^["']|["']$/g, "");
  const msg = $("#keyMsg");
  if (!v) { msg.className = "msg2 bad"; msg.textContent = getKey() ? "המפתח כבר שמור. כדי להחליף אותו, הדביקו מפתח חדש." : "הדביקו את המפתח שקיבלתם ב-Google AI Studio."; $("#keyInput").focus(); return; }
  if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(v)) { msg.className = "msg2 bad"; msg.textContent = "זה לא נראה כמו מפתח Gemini. העתיקו אותו שוב, בלי רווחים."; $("#keyInput").setAttribute("aria-invalid", "true"); $("#keyInput").focus(); return; }
  const b = $("#keySave"); b.disabled = true; msg.className = "msg2"; msg.textContent = "בודק את המפתח מול Google…";
  try {
    const r = await checkKey(v);
    if (v !== getKey()) clearCool();
    localStorage.setItem(KEY, v);
    $("#keyInput").value = ""; $("#keyInput").removeAttribute("aria-invalid"); $("#keyInput").type = "password"; $("#keyShow").textContent = "הצגה"; $("#keyShow").setAttribute("aria-pressed", "false");
    msg.className = "msg2 good";
    msg.textContent = "✓ המפתח תקין ונשמר במכשיר." + (r.transcribe ? " מודל התמלול Gemini 3.5 זמין." : " (מודל התמלול הייעודי לא זמין למפתח הזה – נשתמש ב-Gemini Flash.)");
    syncKeyUi();
    if (sessionStorage.getItem("timlul.afterKey")) { sessionStorage.removeItem("timlul.afterKey"); setTimeout(() => { if (location.hash === "#/key") location.hash = "#/"; }, 900); }
  } catch (e) {
    msg.className = "msg2 bad";
    msg.textContent = isKeyError(e) ? "המפתח לא תקין. ודאו שהעתקתם את כולו מ-Google AI Studio." : heError(e);
    $("#keyInput").setAttribute("aria-invalid", "true"); $("#keyInput").focus();
  } finally { b.disabled = false; }
});
$("#keyDel").addEventListener("click", () => confirmDlg("למחוק את המפתח?", "המפתח יימחק מהדפדפן הזה. התמלולים השמורים לא יימחקו.", () => {
  localStorage.removeItem(KEY); syncKeyUi(); $("#keyMsg").className = "msg2"; $("#keyMsg").textContent = "המפתח נמחק מהמכשיר."; $("#keyInput").focus();
}));

function confirmDlg(title, text, onYes, back) {
  const d = $("#confirmDlg"); $("#dlgT").textContent = title; $("#dlgD").textContent = text;
  d.returnValue = ""; d.showModal();
  d.onclose = () => { if (d.returnValue === "yes") onYes(); else back?.focus(); };
}

// ---------- views ----------
function show(view) {
  for (const v of ["viewNew", "viewMine", "viewJob", "viewKey"]) $("#" + v).hidden = v !== view;
  for (const [n, v] of [["#navNew", "viewNew"], ["#navMine", "viewMine"], ["#navKey", "viewKey"]]) {
    if (view === v) $(n).setAttribute("aria-current", "page"); else $(n).removeAttribute("aria-current");
  }
}
function focusMain() { const h = document.querySelector("main section:not([hidden]) h1"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); } window.scrollTo(0, 0); }

let cur = null, data = null;   // job currently on screen
async function route() {
  cur = null; data = null;
  const h = location.hash || "#/"; let m;
  if ((m = h.match(/^#\/j\/([A-Za-z0-9_-]{8,40})$/))) { show("viewJob"); await openJob(m[1]); }
  else if (h === "#/mine") { show("viewMine"); document.title = "התמלולים שלי – תמלול"; await renderMine(); }
  else if (h === "#/key") { show("viewKey"); document.title = "מפתח Gemini – תמלול"; $("#keyMsg").textContent = ""; syncKeyUi(); }
  else { show("viewNew"); document.title = "תמלול – תמלול שיעורי תורה"; }
  syncBanner();
  if (route.ran) focusMain(); route.ran = true;
}

const ST = { sources: "קורא מקורות", decoding: "מכין שמע", transcribing: "מתמלל", correcting: "עורך", done: "מוכן", error: "נכשל", canceled: "בוטל", interrupted: "הופסק" };
async function renderMine() {
  const h = await store.all(), ul = $("#mineList");
  ul.innerHTML = h.map((j) => {
    const st = running?.job.id === j.id ? running.job.status : j.status;
    const cls = st === "done" ? "done" : ["error", "canceled", "interrupted"].includes(st) ? "err" : "";
    return `<li><a class="item" href="#/j/${esc(j.id)}"><span class="dot ${cls}" aria-hidden="true">${st === "done" ? "✓" : cls ? "!" : "…"}</span>
    <span><span class="t">${esc(j.title || j.fileName || "שיעור")}</span><span class="s">${esc(ST[st] || "")}${j.duration ? " · " + fmtDur(j.duration) : ""} · ${esc(new Date(j.created).toLocaleString("he-IL", { dateStyle: "medium", timeStyle: "short" }))}</span></span></a></li>`;
  }).join("");
  $("#mineEmpty").hidden = h.length > 0;
}

// ---------- new job form ----------
const MEDIA = /\.(mp3|wav|m4a|mp4|webm|ogg|oga|opus|flac|aac|mkv|mov|wma|amr|3gp|m4v|avi|mpeg|mpg|weba)$/i;
const fileLabel = "בחרו קובץ שמע או וידאו, או גררו אותו לכאן";
$("#file").addEventListener("change", () => { const f = $("#file").files[0]; $("#fileName").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)}MB)` : fileLabel; clearErrs(); });
const drop = document.querySelector(".drop");
["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => { if (ev.dataTransfer.files.length) { $("#file").files = ev.dataTransfer.files; $("#file").dispatchEvent(new Event("change")); } });
// a pasted/dropped link: explain politely
drop.addEventListener("drop", (ev) => { if (!ev.dataTransfer.files.length && ev.dataTransfer.getData("text")) showFormErr("קישורים לא נתמכים בגרסה הזו – רק קבצים. הורידו את ההקלטה למכשיר והעלו אותה כאן."); });

function fieldErr(input, errEl, msg) { input.setAttribute("aria-invalid", "true"); errEl.textContent = msg; errEl.hidden = false; }
function clearErrs() { for (const [i, e] of [["#file", "#fileErr"], ["#srcFiles", "#srcErr"]]) { $(i).removeAttribute("aria-invalid"); $(e).hidden = true; } $("#formErr").hidden = true; }
function showFormErr(t) { $("#formErr").textContent = t; $("#formErr").hidden = false; $("#formErr").focus(); }

$("#newForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrs();
  if (!getKey()) { sessionStorage.setItem("timlul.afterKey", "1"); showFormErr("קודם צריך להגדיר מפתח Gemini (פעם אחת). לחצו על „מפתח Gemini” למעלה."); return; }
  if (running) { showFormErr("תמלול אחר עדיין רץ בלשונית הזו. חכו שיסתיים או בטלו אותו."); return; }
  const f = $("#file").files[0]; let bad = null;
  if (!f) bad = () => fieldErr($("#file"), $("#fileErr"), "בחרו קובץ שמע או וידאו.");
  else if (!MEDIA.test(f.name) && !/^(audio|video)\//.test(f.type)) bad = () => fieldErr($("#file"), $("#fileErr"), "זה לא נראה כמו קובץ שמע או וידאו נתמך.");
  else if (f.size > 4 * 1024 ** 3) bad = () => fieldErr($("#file"), $("#fileErr"), "הקובץ גדול מדי (מעל 4GB).");
  const srcs = [...$("#srcFiles").files]; let tot = 0;
  for (const s of srcs) { tot += s.size; if (!SRC_RE.test(s.name)) bad = bad || (() => { $("#srcDetails").open = true; fieldErr($("#srcFiles"), $("#srcErr"), `סוג קובץ לא נתמך: ${s.name}`); }); }
  if (tot > 25 * 1048576) bad = bad || (() => { $("#srcDetails").open = true; fieldErr($("#srcFiles"), $("#srcErr"), "קבצי המקורות גדולים מ־25MB."); });
  if (bad) { bad(); document.querySelector("[aria-invalid=true]")?.focus(); return; }
  const job = {
    id: newId(), title: $("#title").value.trim() || f.name.replace(/\.[^.]+$/, ""), created: new Date().toISOString(),
    fileName: f.name, fileSize: f.size, sourcesText: $("#srcText").value, status: "sources", stage: 1, progress: 0, raw: [], log: [],
  };
  await store.put(job);
  start(job, f, srcs, "full");
  $("#newForm").reset(); $("#fileName").textContent = fileLabel;
  location.hash = "#/j/" + job.id;
});

// ---------- running a job (one at a time per tab) ----------
let running = null, wakeLock = null;
async function lockScreen(on) {
  try { if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {}
}
document.addEventListener("visibilitychange", () => { if (running && document.visibilityState === "visible") lockScreen(true); });
window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

function start(job, file, srcFiles, what) {
  const key = getKey(); const ctl = new AbortController(); const t0 = performance.now();
  running = { job, ctl }; lockScreen(true); syncBanner();
  let lastSave = 0, saving = null;
  const persist = (force) => {
    const now = Date.now();
    if (!force && now - lastSave < 2500) return;
    lastSave = now; saving = store.put(job).catch(() => {});
  };
  const update = (patch) => {
    const stageChanged = patch.status && patch.status !== job.status;
    Object.assign(job, patch, { updated: new Date().toISOString() });
    if (cur === job.id) render(job, stageChanged);
    persist(stageChanged);
  };
  const log = (m) => { job.log.push(new Date().toLocaleTimeString("he-IL") + " " + m); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); };
  (async () => {
    try {
      if (what === "full") {
        if (srcFiles.length || job.sourcesText?.trim()) {
          update({ status: "sources", stage: 1, message: "קורא את דף המקורות…" });
          const s = await extractSources(key, job, srcFiles, { signal: ctl.signal, log });
          update({ sources: s.text, sourcesNotes: s.notes });
        } else update({ sources: "", sourcesNotes: [] });
        await stage1(key, job, file, { signal: ctl.signal, update, log });
      }
      file = null;
      try {
        await stage2(key, job, { signal: ctl.signal, update, log });
        update({ status: "done", stage: 4, error: null, stage2Error: null, finished: new Date().toISOString(), took: (performance.now() - t0) / 1000 + (what === "full" ? 0 : job.took || 0) });
      } catch (e) {
        if (isAbort(e) || isKeyError(e)) throw e;
        log("stage2 failed: " + e.message);
        update({ status: "done", stage: 4, stage2Error: heError(e), finished: new Date().toISOString(), took: (performance.now() - t0) / 1000 });
      }
    } catch (e) {
      if (isAbort(e)) update({ status: "canceled", error: "התמלול בוטל." + (job.raw?.length ? " מה שתומלל עד עכשיו נשמר למטה." : "") });
      else { log("failed: " + (e.stack || e.message)); update({ status: "error", error: heError(e) + (e instanceof GeminiError || isKeyError(e) ? "" : "") }); }
    } finally {
      running = null; lockScreen(false); persist(true); await saving; syncBanner();
      if (cur === job.id) { render(job, true); } else toast(job.status === "done" ? `התמלול „${job.title}” מוכן` : `התמלול „${job.title}” נעצר`);
    }
  })();
}
function syncBanner() {
  const b = $("#runBanner");
  if (running && cur !== running.job.id) { b.hidden = false; $("#runLink").textContent = running.job.title || "שיעור"; $("#runLink").href = "#/j/" + running.job.id; }
  else b.hidden = true;
}
$("#cancelJob").addEventListener("click", () => {
  if (!running || running.job.id !== cur) return;
  confirmDlg("לבטל את התמלול?", "העבודה תיעצר. מה שכבר תומלל יישמר.", () => running?.ctl.abort(), $("#cancelJob"));
});
$("#retry2").addEventListener("click", async () => {
  if (!getKey()) { location.hash = "#/key"; return; }
  if (running) { toast("תמלול אחר עדיין רץ"); return; }
  const j = data || await store.get(cur); if (!j?.rawReady) return;
  j.error = null; j.stage2Error = null;
  start(j, null, [], "correct"); render(j, true);
});

// ---------- one job ----------
async function openJob(id) {
  cur = id;
  const j = running?.job.id === id ? running.job : await store.get(id);
  if (cur !== id) return;
  if (!j) { $("#jTitle").textContent = "התמלול לא נמצא"; $("#jMeta").textContent = "ייתכן שהוא נמחק, או שנשמר בדפדפן אחר."; $("#statusCard").hidden = true; $("#resultBox").hidden = true; document.title = "לא נמצא – תמלול"; return; }
  if (!running || running.job.id !== id) {
    if (["sources", "decoding", "transcribing", "correcting"].includes(j.status)) {    // was running when the page closed
      j.status = "interrupted"; j.error = "התמלול הופסק כי הדף נסגר או רוענן באמצע." + (j.rawReady ? " אפשר להשלים את שלב העריכה." : " כדי להתחיל מחדש, העלו את הקובץ שוב."); await store.put(j);
    }
  }
  render(j, true);
}
function render(j, full) {
  data = j;
  $("#jTitle").textContent = j.title || "שיעור"; document.title = (j.title || "שיעור") + " – תמלול";
  const bits = [];
  if (j.duration) bits.push("אורך " + fmtDur(j.duration));
  if (j.fileName && j.fileName !== j.title) bits.push(j.fileName);
  if (j.took && j.status === "done") bits.push("זמן עיבוד: " + minutes(j.took));
  $("#jMeta").textContent = bits.join(" · ");
  const live = running?.job.id === j.id;
  const stage = j.status === "done" ? 4 : j.stage || 1;
  ["#st1", "#st2", "#st3"].forEach((s, i) => { const el = $(s); el.classList.toggle("ok", stage > i + 1); if (stage === i + 1 && live) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
  let pct;
  if (j.status === "done") pct = 100;
  else if (stage === 1) pct = j.status === "decoding" ? 2 + (j.decodeFrac || 0) * 3 : 1;
  else if (stage === 2) pct = 5 + (j.progress || 0) * 80;
  else pct = 85 + (j.progress || 0) * 15;
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $("#jProg").value = pct; $("#jProg").setAttribute("aria-valuetext", `${pct}%`); $("#jPct").textContent = pct + "%";
  // live message: stage-level only (not every tick), to keep screen readers calm
  const msgs = { sources: "קורא את דף המקורות…", decoding: "מכין את השמע בדפדפן…", transcribing: "מתמלל עם Gemini 3.5…", correcting: j.correctedReady ? "מכין נספח סיפורים ודף מקורות…" : "עורך ומתקן מול המקורות…",
    done: j.stage2Error ? "התמלול הראשוני מוכן, אבל שלב העריכה לא הצליח." : "התמלול מוכן ✓", error: "התמלול נכשל", canceled: "התמלול בוטל", interrupted: "התמלול הופסק" };
  const msg = msgs[j.status] || "";
  if ($("#jMsg").textContent !== msg) $("#jMsg").textContent = msg;
  let sub = "";
  if (j.status === "transcribing" && j.piecesTotal) sub = `${j.piecesDone || 0} מתוך כ־${j.piecesTotal} קטעים${j.eta > 20 ? ` · עוד כ־${minutes(j.eta)}` : ""}`;
  else if (j.status === "decoding" && j.duration) sub = `אורך ההקלטה: ${fmtDur(j.duration)}`;
  else if (j.status === "correcting" && j.piecesTotal && !j.correctedReady) sub = `${j.piecesDone || 0} מתוך ${j.piecesTotal} חלקים`;
  $("#jSub").textContent = sub;
  $("#jKeep").hidden = !live; $("#cancelJob").hidden = !live;
  const failedStage2 = j.status === "done" && j.stage2Error;
  $("#statusCard").hidden = j.status === "done" && !j.stage2Error && !j.failedPieces;
  const err = j.status === "done" ? (j.stage2Error ? "שלב העריכה לא הצליח: " + j.stage2Error : j.failedPieces ? `שימו לב: ${j.failedPieces} קטעים לא תומללו (Gemini לא היה זמין) ומסומנים בתמלול.` : "") : !live ? j.error : "";
  $("#jErr").textContent = err || ""; $("#jErr").hidden = !err;
  $("#retry2").hidden = live || !(j.rawReady && (failedStage2 || ["error", "canceled", "interrupted"].includes(j.status)));
  $("#newAfter").hidden = live || j.status === "done" && !err;
  if (full || !$("#resultBox").dataset.n || j.raw?.length !== +$("#resultBox").dataset.n || j.corrected !== $("#resultBox").dataset.c) renderResult(j);
}
function renderResult(j) {
  const box = $("#resultBox");
  const hasRaw = (j.raw || []).length > 0;
  box.hidden = !hasRaw && !j.corrected;
  box.dataset.n = String(j.raw?.length || 0); box.dataset.c = j.corrected || "";
  if (box.hidden) return;
  if ($("#editBox").hidden === false) return;   // don't clobber an edit in progress
  const fix = (j.corrected || "").trim(), apx = (j.appendix || "").trim();
  $("#fixText").innerHTML = fix ? md(fix + (apx ? "\n\n" + apx : "")) : `<p class="pending">${j.status === "done" || !running ? "התמלול הערוך לא מוכן. אפשר לראות את התמלול הראשוני בלשונית הסמוכה." : "התמלול הערוך יופיע כאן בסוף. בינתיים אפשר לראות את התמלול הראשוני בלשונית הסמוכה."}</p>`;
  ["#editBtn", "#copyBtn", "#dlDocx", "#dlMd", "#dlTxt"].forEach((s) => { $(s).disabled = !fix; });
  $("#delBtn").disabled = running?.job.id === j.id;
  $("#rawText").innerHTML = (j.raw || []).map((s) => `<p>${inline(`[${fmtDur(s.start)}] ${s.text}`)}</p>`).join("") || "<p>אין</p>";
  const notes = j.sourcesNotes || [];
  $("#srcNotes").innerHTML = notes.map((n) => `<li>${esc(n.name)} · ${esc(n.note)}${n.chars ? ` · ${n.chars.toLocaleString("he-IL")} תווים` : ""}</li>`).join("");
  $("#srcText2").textContent = j.sources || "לא צורף דף מקורות לשיעור הזה.";
  applyTs();
  if (!fix && hasRaw && $("#tabFix").getAttribute("aria-selected") === "true" && running?.job.id === j.id) selectTab($("#tabRaw"));
  if (fix && j.status === "done" && box.dataset.sel !== "fix") { box.dataset.sel = "fix"; selectTab($("#tabFix")); }
}
function applyTs() { const on = $("#showTs").checked; for (const s of ["#fixText", "#rawText"]) $(s).classList.toggle("nots", !on); }
$("#showTs").addEventListener("change", applyTs);

// tabs (arrow keys per WAI-ARIA)
const tabs = ["#tabFix", "#tabRaw", "#tabSrc"].map((s) => $(s));
function selectTab(t, focus) {
  tabs.forEach((x) => { const on = x === t; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; $("#" + x.getAttribute("aria-controls")).hidden = !on; });
  if (focus) t.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const n = tabs.length; let k = null;
    if (e.key === "ArrowLeft") k = (i + 1) % n; else if (e.key === "ArrowRight") k = (i - 1 + n) % n; else if (e.key === "Home") k = 0; else if (e.key === "End") k = n - 1;
    if (k !== null) { e.preventDefault(); selectTab(tabs[k], true); }
  });
});

// ---------- result actions ----------
const fullMd = () => { const j = data; const t = (j.corrected || "").trim() + (j.appendix ? "\n\n" + j.appendix.trim() : ""); return $("#showTs").checked ? t : stripTs(t); };
const rawTxt = () => (data.raw || []).map((s) => ($("#showTs").checked ? ts(s.start) + " " : "") + s.text).join("\n\n");
$("#editBtn").addEventListener("click", () => { $("#editArea").value = data.corrected || ""; $("#editBox").hidden = false; $("#fixText").hidden = true; $("#editArea").focus(); });
$("#cancelBtn").addEventListener("click", () => { $("#editBox").hidden = true; $("#fixText").hidden = false; $("#editBtn").focus(); });
$("#saveBtn").addEventListener("click", async () => {
  data.corrected = $("#editArea").value; data.edited = new Date().toISOString(); await store.put(data); toast("נשמר");
  $("#editBox").hidden = true; $("#fixText").hidden = false; renderResult(data); $("#editBtn").focus();
});
async function copy(t) { try { await navigator.clipboard.writeText(t); toast("הועתק"); } catch { toast("ההעתקה לא הצליחה"); } }
$("#copyBtn").addEventListener("click", () => copy(toTxt(fullMd())));
$("#copyRaw").addEventListener("click", () => copy(rawTxt()));
$("#dlMd").addEventListener("click", () => download(new Blob([`# ${data.title || "תמלול"}\n\n` + fullMd() + "\n"], { type: "text/markdown;charset=utf-8" }), safeName(data.title) + ".md"));
$("#dlTxt").addEventListener("click", () => download(new Blob(["\ufeff" + (data.title ? data.title + "\n\n" : "") + toTxt(fullMd()) + "\n"], { type: "text/plain;charset=utf-8" }), safeName(data.title) + ".txt"));
$("#dlDocx").addEventListener("click", () => download(toDocx(fullMd(), data.title), safeName(data.title) + ".docx"));
$("#dlRaw").addEventListener("click", () => download(new Blob(["\ufeff" + rawTxt() + "\n"], { type: "text/plain;charset=utf-8" }), safeName(data.title) + " – תמלול ראשוני.txt"));
$("#delBtn").addEventListener("click", () => confirmDlg("למחוק את התמלול?", "התמלול יימחק מהמכשיר הזה ולא יהיה אפשר לשחזר אותו.", async () => {
  await store.del(cur); toast("התמלול נמחק"); location.hash = "#/mine";
}, $("#delBtn")));

// ---------- start ----------
window.addEventListener("hashchange", route);
syncKeyUi();
route();
