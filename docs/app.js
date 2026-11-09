/* תמלול – front end. Talks to the API given in config.json (empty = same origin). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  let API = "";
  const HKEY = "timlul.jobs.v1";
  let pollTimer = null, cur = null, data = null, editing = false;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const minutes = (s) => { const m = Math.round((s || 0) / 60); return m < 1 ? "פחות מדקה" : m === 1 ? "דקה" : m === 2 ? "שתי דקות" : `${m} דקות`; };
  function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2600); }
  function hist() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; } }
  function setHist(h) { try { localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 50))); } catch {} }
  function remember(j) { const h = hist().filter((x) => x.id !== j.id); h.unshift({ id: j.id, title: j.title, created: j.created, status: j.status }); setHist(h); }
  function patchHist(j) { const h = hist(); const x = h.find((x) => x.id === j.id); if (x) { x.title = j.title; x.status = j.status; setHist(h); } }

  async function api(path, opt = {}) {
    let r;
    try { r = await fetch(API + path, opt); }
    catch (e) { offline(true); throw new Error("אין חיבור לשרת התמלול כרגע. בדקו את החיבור לאינטרנט ונסו שוב בעוד רגע."); }
    offline(false);
    if (!r.ok) {
      let msg = `שגיאה (${r.status})`;
      try { const j = await r.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : msg; } catch {}
      if (r.status === 502 || r.status === 530 || r.status === 503) msg = "שרת התמלול לא זמין כרגע. נסו שוב בעוד כמה דקות.";
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r;
  }
  function offline(on, text) {
    const b = $("#offline");
    b.textContent = text || "שרת התמלול לא זמין כרגע. התמלולים שלכם שמורים, ואפשר לנסות שוב בעוד כמה דקות.";
    b.hidden = !on;
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

  // ---------- views ----------
  function show(view) {
    for (const v of ["viewNew", "viewMine", "viewJob"]) $("#" + v).hidden = v !== view;
    $("#navNew").toggleAttribute("aria-current", view === "viewNew"); if (view === "viewNew") $("#navNew").setAttribute("aria-current", "page");
    $("#navMine").toggleAttribute("aria-current", view === "viewMine"); if (view === "viewMine") $("#navMine").setAttribute("aria-current", "page");
  }
  function focusMain() { const h = document.querySelector("main section:not([hidden]) h1"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); } window.scrollTo(0, 0); }

  async function route() {
    clearTimeout(pollTimer); cur = null; data = null; editing = false;
    const h = location.hash || "#/";
    let m;
    if ((m = h.match(/^#\/j\/([A-Za-z0-9_-]{20,40})$/))) { show("viewJob"); document.title = "תמלול – טוען…"; await openJob(m[1]); }
    else if (h === "#/mine") { show("viewMine"); document.title = "התמלולים שלי – תמלול"; renderMine(); }
    else { show("viewNew"); document.title = "תמלול – תמלול שיעורי תורה"; }
    if (route.ran) focusMain(); route.ran = true;
  }

  const ST = { queued: "בתור", downloading: "מוריד", converting: "מכין שמע", sources: "קורא מקורות", transcribing: "מתמלל", correcting: "עורך", done: "מוכן", error: "נכשל" };
  function renderMine() {
    const h = hist(), ul = $("#mineList");
    ul.innerHTML = h.map((j) => `<li><a class="item" href="#/j/${esc(j.id)}"><span class="dot ${j.status === "done" ? "done" : j.status === "error" ? "err" : ""}" aria-hidden="true">${j.status === "done" ? "✓" : j.status === "error" ? "!" : "…"}</span>
      <span><span class="t">${esc(j.title || "שיעור")}</span><span class="s">${esc(ST[j.status] || "")} · ${esc(new Date(j.created).toLocaleString("he-IL", { dateStyle: "medium", timeStyle: "short" }))}</span></span></a></li>`).join("");
    $("#mineEmpty").hidden = h.length > 0;
  }

  // ---------- new job form ----------
  const kindFile = () => $("#kFile").checked;
  function syncKind() { $("#linkBox").hidden = kindFile(); $("#fileBox").hidden = !kindFile(); clearErrs(); }
  $("#kLink").addEventListener("change", syncKind); $("#kFile").addEventListener("change", syncKind);
  $("#file").addEventListener("change", () => { const f = $("#file").files[0]; $("#fileName").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)}MB)` : "בחרו קובץ או גררו אותו לכאן"; clearErrs(); });
  const drop = document.querySelector(".drop");
  ["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (ev) => { if (ev.dataTransfer.files.length) { $("#file").files = ev.dataTransfer.files; $("#file").dispatchEvent(new Event("change")); } });

  function fieldErr(input, errEl, msg) { input.setAttribute("aria-invalid", "true"); errEl.textContent = msg; errEl.hidden = false; }
  function clearErrs() {
    for (const [i, e] of [["#url", "#urlErr"], ["#file", "#fileErr"], ["#srcFiles", "#srcErr"]]) { $(i).removeAttribute("aria-invalid"); $(e).hidden = true; }
    $("#formErr").hidden = true;
  }
  const MEDIA = /\.(mp3|wav|m4a|mp4|webm|ogg|oga|opus|flac|aac|mkv|mov|wma|amr|3gp|m4v|avi|mpeg|mpg)$/i;
  const SRC = /\.(pdf|png|jpe?g|webp|gif|heic|txt|md|docx)$/i;

  async function uploadMedia(f) {
    const r = await (await api("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, size: f.size }) })).json();
    const step = r.piece; let off = 0;
    $("#upWrap").hidden = false;
    while (off < f.size) {
      const part = f.slice(off, off + step);
      let tries = 0, res;
      for (;;) {
        try { res = await api(`/api/uploads/${r.upload_id}?offset=${off}`, { method: "PUT", body: part }); break; }
        catch (e) { if (++tries >= 4 || e.status === 400 || e.status === 404) throw e; await new Promise((ok) => setTimeout(ok, 1500 * tries)); }
      }
      off = (await res.json()).received;
      const pct = Math.round((off / f.size) * 100);
      $("#upProg").value = pct; $("#upLbl").textContent = `מעלה את הקובץ… ${pct}%`;
    }
    return r.upload_id;
  }

  $("#newForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); clearErrs();
    const fd = new FormData(); let bad = null;
    if (kindFile()) {
      const f = $("#file").files[0];
      if (!f) bad = () => fieldErr($("#file"), $("#fileErr"), "בחרו קובץ שמע או וידאו.");
      else if (!MEDIA.test(f.name)) bad = () => fieldErr($("#file"), $("#fileErr"), "זה לא נראה כמו קובץ שמע או וידאו נתמך.");
      else if (f.size > 2 * 1024 ** 3) bad = () => fieldErr($("#file"), $("#fileErr"), "הקובץ גדול מ־2GB.");
    } else {
      const u = $("#url").value.trim();
      if (!u) bad = () => fieldErr($("#url"), $("#urlErr"), "הדביקו קישור לשיעור.");
      else if (!/^https?:\/\/\S+\.\S+/.test(u)) bad = () => fieldErr($("#url"), $("#urlErr"), "הקישור צריך להתחיל ב־https://");
      else fd.append("url", u);
    }
    const srcs = [...$("#srcFiles").files]; let tot = 0;
    for (const s of srcs) { tot += s.size; if (!SRC.test(s.name)) { bad = bad || (() => { $("#srcDetails").open = true; fieldErr($("#srcFiles"), $("#srcErr"), `סוג קובץ לא נתמך: ${s.name}`); }); } }
    if (tot > 25 * 1048576) bad = bad || (() => { $("#srcDetails").open = true; fieldErr($("#srcFiles"), $("#srcErr"), "קבצי המקורות גדולים מ־25MB."); });
    if (bad) { bad(); document.querySelector("[aria-invalid=true]")?.focus(); return; }
    srcs.forEach((s) => fd.append("sources", s));
    fd.append("title", $("#title").value.trim()); fd.append("sources_text", $("#srcText").value);
    const btn = $("#go"); btn.disabled = true; btn.textContent = "שולח…";
    try {
      if (kindFile()) fd.append("upload_id", await uploadMedia($("#file").files[0]));
      const j = await (await api("/api/jobs", { method: "POST", body: fd })).json();
      remember(j); $("#newForm").reset(); syncKind(); $("#fileName").textContent = "בחרו קובץ או גררו אותו לכאן";
      location.hash = "#/j/" + j.id;
    } catch (e) {
      $("#formErr").textContent = e.message; $("#formErr").hidden = false; $("#formErr").focus?.();
    } finally { btn.disabled = false; btn.textContent = "התחילו תמלול"; $("#upWrap").hidden = true; $("#upProg").value = 0; }
  });

  // ---------- one job ----------
  async function openJob(id) {
    cur = id;
    $("#resultBox").hidden = true; $("#statusCard").hidden = false; $("#jErr").hidden = true; $("#jErrActions").hidden = true;
    $("#jTitle").textContent = "טוען…"; $("#jMeta").textContent = ""; $("#jMsg").textContent = "";
    await poll();
  }
  async function poll() {
    if (!cur) return;
    const id = cur; let j;
    try { j = await (await api("/api/jobs/" + id)).json(); }
    catch (e) {
      if (e.status === 404) { $("#jTitle").textContent = "התמלול לא נמצא"; $("#jMsg").textContent = e.message; $("#jProg").hidden = true; return; }
      $("#jMsg").textContent = e.message; pollTimer = setTimeout(poll, 8000); return;
    }
    if (id !== cur) return;
    $("#jProg").hidden = false;
    remember(j); renderStatus(j);
    if (j.status === "done" || j.status === "error") { if (j.raw_ready) await loadResult(id); }
    else pollTimer = setTimeout(poll, 2500);
  }
  function renderStatus(j) {
    $("#jTitle").textContent = j.title || "שיעור"; document.title = (j.title || "שיעור") + " – תמלול";
    const bits = [];
    if (j.duration) bits.push("אורך " + fmtDur(j.duration));
    if (j.url) bits.push(j.url);
    if (j.original_name) bits.push(j.original_name);
    if (j.took && j.status === "done") bits.push("זמן עיבוד: " + minutes(j.took));
    $("#jMeta").textContent = bits.join(" · ");
    const stage = ["queued", "downloading", "converting", "sources"].includes(j.status) ? 1 : j.status === "transcribing" ? 2 : j.status === "correcting" ? 3 : 4;
    ["#st1", "#st2", "#st3"].forEach((s, i) => { const el = $(s); el.classList.toggle("ok", stage > i + 1); if (stage === i + 1) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
    const pct = stage === 1 ? 3 : stage === 2 ? 5 + (j.progress || 0) * 75 : stage === 3 ? 80 + (j.progress || 0) * 20 : 100;
    $("#jProg").value = Math.round(pct); $("#jProg").setAttribute("aria-valuetext", `${Math.round(pct)}% – ${j.message || ""}`);
    let msg = j.message || "";
    if (j.status === "queued" && j.queue_position > 1) msg += ` (מקום ${j.queue_position} בתור)`;
    if (j.status === "transcribing" && j.eta > 5) msg += ` · עוד כ־${minutes(j.eta)}`;
    if ($("#jMsg").textContent !== msg) $("#jMsg").textContent = msg;
    $("#statusCard").hidden = j.status === "done" && !j.stage2_error;
    if (j.status === "error") { $("#jErr").textContent = j.error || "התמלול נכשל"; $("#jErr").hidden = false; $("#jErrActions").hidden = false; $("#retry2").hidden = !j.raw_ready; }
    else if (j.stage2_error) { $("#jErr").textContent = "שלב העריכה לא הצליח: " + j.stage2_error; $("#jErr").hidden = false; $("#jErrActions").hidden = false; $("#retry2").hidden = false; }
    else { $("#jErr").hidden = true; $("#jErrActions").hidden = true; }
  }
  async function loadResult(id) {
    try { data = await (await api(`/api/jobs/${id}/result`)).json(); } catch (e) { $("#jMsg").textContent = e.message; return; }
    if (id !== cur) return;
    const fix = (data.corrected || "").trim(), apx = (data.appendix || "").trim();
    $("#fixText").innerHTML = fix ? md(fix + (apx ? "\n\n" + apx : "")) : "<p>התמלול הערוך עוד לא מוכן. אפשר לראות את התמלול הראשוני בלשונית הסמוכה.</p>";
    $("#rawText").innerHTML = (data.raw || []).map((s) => `<p>${inline(`[${fmtDur(s.start)}] ${s.text}`)}</p>`).join("") || "<p>אין</p>";
    const notes = (data.job.sources_notes || []);
    $("#srcNotes").innerHTML = notes.map((n) => `<li>${esc(n.name)} · ${esc(n.note)}${n.chars ? ` · ${n.chars.toLocaleString("he-IL")} תווים` : ""}</li>`).join("");
    $("#srcText2").textContent = data.sources || "לא צורף דף מקורות לשיעור הזה.";
    const q = (k, f) => `${API}/api/jobs/${id}/download?kind=${k}&fmt=${f}&stamps=${$("#showTs").checked ? 1 : 0}`;
    const setDl = () => { $("#dlMd").href = q("corrected", "md"); $("#dlTxt").href = q("corrected", "txt"); $("#dlRaw").href = q("raw", "txt"); };
    setDl(); $("#showTs").onchange = () => { applyTs(); setDl(); };
    applyTs(); $("#resultBox").hidden = false; $("#editBox").hidden = true; $("#fixText").hidden = false;
  }
  function applyTs() { const on = $("#showTs").checked; for (const s of ["#fixText", "#rawText"]) $(s).classList.toggle("nots", !on); }

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

  $("#editBtn").addEventListener("click", () => {
    editing = true; $("#editArea").value = (data && data.corrected) || ""; $("#editBox").hidden = false; $("#fixText").hidden = true; $("#editArea").focus();
  });
  $("#cancelBtn").addEventListener("click", () => { editing = false; $("#editBox").hidden = true; $("#fixText").hidden = false; $("#editBtn").focus(); });
  $("#saveBtn").addEventListener("click", async () => {
    const text = $("#editArea").value;
    try {
      await api(`/api/jobs/${cur}/corrected`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      data.corrected = text; toast("נשמר"); editing = false;
      $("#fixText").innerHTML = md(text + (data.appendix ? "\n\n" + data.appendix : "")); applyTs();
      $("#editBox").hidden = true; $("#fixText").hidden = false; $("#editBtn").focus();
    } catch (e) { toast(e.message); }
  });
  $("#copyBtn").addEventListener("click", async () => {
    const t = $("#fixText").innerText;
    try { await navigator.clipboard.writeText(t); toast("התמלול הועתק"); } catch { toast("ההעתקה לא הצליחה"); }
  });
  $("#retry2").addEventListener("click", async () => {
    try { await api(`/api/jobs/${cur}/correct`, { method: "POST" }); $("#jErr").hidden = true; $("#jErrActions").hidden = true; poll(); }
    catch (e) { toast(e.message); }
  });
  $("#delBtn").addEventListener("click", () => {
    const d = $("#confirmDlg");
    d.returnValue = ""; d.showModal();
    d.onclose = async () => {
      if (d.returnValue !== "yes") { $("#delBtn").focus(); return; }
      try { await api(`/api/jobs/${cur}`, { method: "DELETE" }); setHist(hist().filter((x) => x.id !== cur)); toast("התמלול נמחק"); location.hash = "#/mine"; }
      catch (e) { toast(e.message); }
    };
  });

  // ---------- start ----------
  async function init() {
    try {
      const r = await fetch("config.json?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) API = String((await r.json()).api || "").replace(/\/+$/, "");
    } catch {}
    window.addEventListener("hashchange", route);
    route();
    try { const h = await (await api("/api/health")).json(); if (!h.ready) offline(true, "השרת פועל, אבל שירות התמלול עוד לא הוגדר."); }
    catch { offline(true, "שרת התמלול עדיין לא מחובר לאתר הזה, ולכן אי אפשר להתחיל תמלול כרגע. אפשר להכיר את האתר, ונעדכן כשהשרת יעלה."); }
  }
  init();
})();
