/* Job history – kept only in this browser (IndexedDB, with a localStorage fallback). */
const DB = "timlul", ST = "jobs";
let dbp = null;
function db() {
  return dbp ||= new Promise((ok, no) => {
    if (!window.indexedDB) return no(new Error("no idb"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: "id" });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
const LS = "timlul.jobs.local.v2";
const lsAll = () => { try { return JSON.parse(localStorage.getItem(LS)) || []; } catch { return []; } };
const lsSet = (a) => { try { localStorage.setItem(LS, JSON.stringify(a.slice(0, 30))); } catch {} };

function tx(mode, fn) {
  return db().then((d) => new Promise((ok, no) => {
    const t = d.transaction(ST, mode), s = t.objectStore(ST); const r = fn(s);
    t.oncomplete = () => ok(r && "result" in r ? r.result : undefined); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
  }));
}
export async function put(job) {
  const j = JSON.parse(JSON.stringify(job));
  try { await tx("readwrite", (s) => s.put(j)); }
  catch { const a = lsAll().filter((x) => x.id !== j.id); a.unshift(j); lsSet(a); }
}
export async function get(id) {
  try { return await tx("readonly", (s) => s.get(id)); } catch { return lsAll().find((x) => x.id === id); }
}
export async function all() {
  let a; try { a = await tx("readonly", (s) => s.getAll()); } catch { a = lsAll(); }
  return (a || []).sort((x, y) => String(y.created).localeCompare(String(x.created)));
}
export async function del(id) {
  try { await tx("readwrite", (s) => s.delete(id)); } catch { lsSet(lsAll().filter((x) => x.id !== id)); }
}
