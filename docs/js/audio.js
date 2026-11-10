/* Audio in the browser: decode any audio/video file piece by piece, downmix to mono 16 kHz,
   cut into ~2-minute chunks at quiet points, encode each as a small WAV blob.
   Memory stays bounded: MP3 / WAV / MP4-family files are decoded in segments; other formats are decoded whole. */
export const SR = 16000;
export const PIECE = 120;          // seconds of audio per transcription call
const WIN = 25;                    // search ±25 s around the target for a pause
const SEG = 300;                   // seconds of compressed audio decoded at a time

const abortErr = () => new DOMException("aborted", "AbortError");
const OAC = () => window.OfflineAudioContext || window.webkitOfflineAudioContext;

export class AudioError extends Error {}

// ---------------- WAV encoding ----------------
export function wavBlob(f32) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44, n);
  for (let i = 0; i < n; i++) { let s = f32[i]; s = s > 1 ? 1 : s < -1 ? -1 : s; out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------- chunker: accumulates 16 kHz mono, emits ~PIECE-second pieces cut in a pause ----------------
class Chunker {
  constructor(emit, pieceFor) {
    this.emit = emit; this.pieceFor = pieceFor; this.fill = 0; this.t = 0; this.peak = 0; this.buf = null;
  }
  setDuration(d) {                         // choose the piece length once, before the first sample arrives
    if (this.buf) return;
    this.piece = Math.round(this.pieceFor ? this.pieceFor(d || 0) : PIECE);
    this.cap = (this.piece + WIN + 60) * SR; this.buf = new Float32Array(this.cap);
  }
  quietPoint(lo, hi, target) {           // sample indexes within this.buf; returns best cut index
    const F = 800;                         // 50 ms frames
    const a = Math.max(0, Math.floor(lo / F)), b = Math.min(Math.floor(this.fill / F), Math.floor(hi / F));
    if (b - a < 4) return target;
    const e = new Float32Array(b - a);
    for (let k = a; k < b; k++) { let s = 0; const o = k * F; for (let i = 0; i < F; i++) { const x = this.buf[o + i]; s += x * x; } e[k - a] = s; }
    let best = target, bestScore = Infinity; const W = 8;   // 400 ms moving window
    let acc = 0; for (let i = 0; i < Math.min(W, e.length); i++) acc += e[i];
    for (let i = 0; i + W <= e.length; i++) {
      if (i) acc += e[i + W - 1] - e[i - 1];
      const mid = (a + i + W / 2) * F;
      const score = (acc + 1e-6) * (1 + 0.6 * Math.abs(mid - target) / (WIN * SR));
      if (score < bestScore) { bestScore = score; best = mid; }
    }
    return Math.round(best);
  }
  async cut(at) {
    const piece = this.buf.slice(0, at);
    const start = this.t, end = this.t + at / SR;
    this.buf.copyWithin(0, at, this.fill); this.fill -= at; this.t = end;
    await this.emit({ start, end, blob: wavBlob(piece) });
  }
  async push(f32) {
    if (!this.buf) this.setDuration(0);
    const PIECE = this.piece;
    let off = 0;
    while (off < f32.length) {
      const n = Math.min(f32.length - off, this.cap - this.fill);
      this.buf.set(f32.subarray(off, off + n), this.fill); this.fill += n; off += n;
      for (let i = this.fill - n; i < this.fill; i++) { const x = Math.abs(this.buf[i]); if (x > this.peak) this.peak = x; }
      if (this.fill >= (PIECE + WIN) * SR) await this.cut(this.quietPoint((PIECE - WIN) * SR, (PIECE + WIN) * SR, PIECE * SR));
    }
  }
  async end() {
    if (!this.buf) return this.t;
    const PIECE = this.piece;
    if (this.fill > PIECE * 1.4 * SR) await this.cut(this.quietPoint((PIECE - WIN) * SR, Math.min(this.fill - 10 * SR, (PIECE + WIN) * SR), PIECE * SR));
    if (this.fill > SR * 0.3) await this.cut(this.fill); else this.t += this.fill / SR;
    return this.t;
  }
}

// ---------------- helpers ----------------
function mono(ab) {               // AudioBuffer -> Float32Array (average of channels)
  const n = ab.numberOfChannels;
  if (n === 1) return ab.getChannelData(0);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < n; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
function decode16k(arrayBuffer) {   // native decoder, resampled to 16 kHz by the browser
  const C = OAC(); const ctx = new C(1, 1, SR);
  return new Promise((ok, no) => {
    const p = ctx.decodeAudioData(arrayBuffer, ok, (e) => no(e || new Error("decode failed")));
    if (p && p.then) p.then(ok, no);
  });
}
async function resample16k(planes, rate) {   // Float32Array[] at `rate` -> mono 16 kHz
  const len = planes[0].length; if (!len) return new Float32Array(0);
  if (rate === SR && planes.length === 1) return planes[0];
  const C = OAC(); const outLen = Math.max(1, Math.round(len * SR / rate));
  const ctx = new C(1, outLen, SR);
  const b = ctx.createBuffer(planes.length, len, rate);
  planes.forEach((p, c) => b.copyToChannel ? b.copyToChannel(p, c) : b.getChannelData(c).set(p));
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
  const r = await ctx.startRendering();
  return r.getChannelData(0);
}
async function readHead(file, n) { return new Uint8Array(await file.slice(0, n).arrayBuffer()); }

export async function sniff(file) {
  const h = await readHead(file, 64);
  const s = (o, l) => String.fromCharCode(...h.slice(o, o + l));
  if (s(0, 4) === "RIFF" && s(8, 4) === "WAVE") return "wav";
  if (s(4, 4) === "ftyp") return "mp4";
  if (s(0, 3) === "ID3" || (h[0] === 0xff && (h[1] & 0xe6) === 0xe2)) return "mp3";
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return "aac";
  if (s(0, 4) === "OggS") return "ogg";
  if (s(0, 4) === "fLaC") return "flac";
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return "webm";
  if (/\.mp3$/i.test(file.name)) return "mp3";
  return "other";
}

// ---------------- MP3: decode in byte segments cut on frame boundaries ----------------
const BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const SRS = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Header(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
  const kbps = BR[ver === 3 ? 1 : 2][bri], rate = SRS[ver][sri];
  const len = Math.floor((ver === 3 ? 144000 : 72000) * kbps / rate) + pad;
  return { ver, rate, kbps, len };
}
function findSync(b, from) {
  for (let i = from; i < b.length - 4; i++) {
    const h = mp3Header(b, i); if (!h) continue;
    const h2 = mp3Header(b, i + h.len);
    if (h2 && h2.ver === h.ver && h2.rate === h.rate) return { i, h };
  }
  return null;
}
async function mp3Info(file) {
  const head = await readHead(file, 256 * 1024);
  let off = 0;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) off = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f));
  let first;
  if (off < head.length - 8) first = findSync(head, off);
  else { const b = new Uint8Array(await file.slice(off, off + 65536).arrayBuffer()); const f = findSync(b, 0); if (f) first = { i: f.i + off, h: f.h }; }
  if (!first) return null;
  // average bitrate from a sample of frames (handles VBR reasonably)
  const s = new Uint8Array(await file.slice(first.i, first.i + 512 * 1024).arrayBuffer());
  let i = 0, frames = 0, bytes = 0;
  while (i < s.length - 4 && frames < 400) { const h = mp3Header(s, i); if (!h) break; bytes += h.len; frames++; i += h.len; }
  const kbps = frames > 10 ? (bytes * 8 / (frames * (first.h.ver === 3 ? 1152 : 576) / first.h.rate)) / 1000 : first.h.kbps;
  return { start: first.i, kbps, duration: (file.size - first.i) * 8 / (kbps * 1000) };
}
async function* mp3Segments(file, info) {
  const step = Math.max(256 * 1024, Math.round(info.kbps * 1000 / 8 * SEG));
  let a = info.start;
  while (a < file.size) {
    let b = Math.min(file.size, a + step);
    if (b < file.size) {
      const look = new Uint8Array(await file.slice(b, Math.min(file.size, b + 16384)).arrayBuffer());
      const f = findSync(look, 0); b = f ? b + f.i : Math.min(file.size, b + look.length);
      if (file.size - b < step * 0.25) b = file.size;   // don't leave a tiny tail
    }
    yield { a, b };
    a = b;
  }
}

// ---------------- WAV: decode in segments with a synthesized header ----------------
async function wavInfo(file) {
  const h = new DataView(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer());
  let o = 12, fmt = null, data = null;
  while (o + 8 <= h.byteLength) {
    const id = String.fromCharCode(h.getUint8(o), h.getUint8(o + 1), h.getUint8(o + 2), h.getUint8(o + 3)), sz = h.getUint32(o + 4, true);
    if (id === "fmt ") fmt = { o: o + 8, sz, tag: h.getUint16(o + 8, true), ch: h.getUint16(o + 10, true), rate: h.getUint32(o + 12, true), byteRate: h.getUint32(o + 16, true), align: h.getUint16(o + 20, true), bits: h.getUint16(o + 22, true) };
    if (id === "data") { data = { o: o + 8, sz: Math.min(sz || file.size, file.size - o - 8) }; break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || !fmt.byteRate || !fmt.align) return null;
  const fmtBytes = new Uint8Array(await file.slice(fmt.o, fmt.o + fmt.sz).arrayBuffer());
  return { ...fmt, fmtBytes, data, duration: data.sz / fmt.byteRate };
}
function wavPiece(info, bytes) {
  const fb = info.fmtBytes, head = new ArrayBuffer(12 + 8 + fb.length + 8), v = new DataView(head), u = new Uint8Array(head);
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, head.byteLength - 8 + bytes.size, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, fb.length, true);
  u.set(fb, 20); w(20 + fb.length, "data"); v.setUint32(24 + fb.length, bytes.size, true);
  return new Blob([head, bytes]);
}

// ---------------- MP4 / M4A / MOV: mp4box.js demux + WebCodecs AudioDecoder ----------------
async function mp4Open(file, signal) {
  if (!window.MP4Box) await loadScript("vendor/mp4box.all.min.js");
  const mp = window.MP4Box.createFile(); let info = null, err = null;
  mp.onReady = (i) => { info = i; }; mp.onError = (e) => { err = e; };
  let off = 0, guard = 0; const CH = 2 * 1024 * 1024;
  while (!info && !err && off < file.size && guard++ < 100000) {
    if (signal?.aborted) throw abortErr();
    const ab = await file.slice(off, Math.min(file.size, off + CH)).arrayBuffer(); ab.fileStart = off;
    const next = mp.appendBuffer(ab, off + ab.byteLength >= file.size);
    off = next && next > off ? next : off + ab.byteLength;
  }
  if (!info && !err) { try { mp.flush(); } catch {} }
  if (err || !info) throw new AudioError("mp4: " + (err || "no moov"));
  const tr = (info.audioTracks || [])[0];
  if (!tr) throw new AudioError("לא נמצא ערוץ שמע בקובץ.");
  return { mp, tr, duration: tr.duration / tr.timescale || info.duration / info.timescale };
}
function mp4Description(mp, id) {
  const trak = mp.getTrackById(id);
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const esds = e.esds || (e.wave && e.wave.esds);
    if (esds && esds.esd) {
      const d = esds.esd.findDescriptor ? esds.esd.findDescriptor(4) : esds.esd.descs[0];
      const dsi = d && (d.findDescriptor ? d.findDescriptor(5) : d.descs[0]);
      if (dsi && dsi.data) return new Uint8Array(dsi.data);
    }
    if (e.dOps) { /* opus in mp4 – decoder works without description for mono/stereo */ return undefined; }
  }
  return undefined;
}
async function decodeMp4(file, chunker, onProgress, signal) {
  if (!window.AudioDecoder || !window.EncodedAudioChunk) throw new AudioError("no WebCodecs");
  const { mp, tr, duration } = await mp4Open(file, signal);
  const rate = tr.audio.sample_rate, chans = tr.audio.channel_count;
  const cfg = { codec: tr.codec, sampleRate: rate, numberOfChannels: chans };
  const desc = mp4Description(mp, tr.id); if (desc) cfg.description = desc;
  const sup = await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
  if (!sup.supported) throw new AudioError("codec not supported: " + tr.codec);
  onProgress?.(0, duration);
  const samples = mp.getTrackSamplesInfo(tr.id).map((s) => ({ offset: s.offset, size: s.size, dts: s.dts, dur: s.duration, ts: s.timescale }));
  try { mp.stop?.(); } catch {}
  let planes = [], got = 0, decErr = null, outRate = rate;
  const dec = new AudioDecoder({
    output: (ad) => {
      try {
        outRate = ad.sampleRate; const n = ad.numberOfFrames, nc = ad.numberOfChannels;
        const arr = []; for (let c = 0; c < nc; c++) { const p = new Float32Array(n); ad.copyTo(p, { planeIndex: c, format: "f32-planar" }); arr.push(p); }
        planes.push(arr); got += n;
      } catch (e) { decErr = e; } finally { ad.close(); }
    },
    error: (e) => { decErr = e; },
  });
  dec.configure(cfg);
  const flushPlanes = async () => {
    if (!got) return;
    const nc = planes[0].length, merged = [];
    for (let c = 0; c < nc; c++) { const m = new Float32Array(got); let o = 0; for (const p of planes) { m.set(p[c] || p[0], o); o += p[0].length; } merged.push(m); }
    planes = []; got = 0;
    await chunker.push(await resample16k(merged, outRate));
  };
  const BATCH = 4 * 1024 * 1024; let i = 0;
  while (i < samples.length) {
    if (signal?.aborted) { dec.close(); throw abortErr(); }
    // contiguous-ish batch of samples read with one slice
    let j = i, lo = samples[i].offset, hi = lo, secs = 0;
    while (j < samples.length && secs < 45 && samples[j].offset + samples[j].size - lo <= BATCH && samples[j].offset >= lo) { hi = Math.max(hi, samples[j].offset + samples[j].size); secs += samples[j].dur / samples[j].ts; j++; }
    if (j === i) { hi = samples[i].offset + samples[i].size; j = i + 1; }
    const buf = new Uint8Array(await file.slice(lo, hi).arrayBuffer());
    for (let k = i; k < j; k++) {
      const s = samples[k];
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(s.dts / s.ts * 1e6), duration: Math.round(s.dur / s.ts * 1e6), data: buf.subarray(s.offset - lo, s.offset - lo + s.size) }));
    }
    await dec.flush();
    if (decErr) { try { dec.close(); } catch {} throw new AudioError("decode: " + decErr); }
    await flushPlanes();
    i = j; onProgress?.(i / samples.length, duration);
  }
  await flushPlanes(); try { dec.close(); } catch {}
  return duration;
}

let _scripts = {};
export function loadScript(src) {
  return _scripts[src] ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { delete _scripts[src]; no(new Error("load " + src)); }; document.head.appendChild(s); });
}

/**
 * Decode `file` and call `emit({start,end,blob})` for each ~2-minute piece (awaited: use it for back-pressure).
 * onProgress(fraction, durationSecondsOrNull). Returns total duration in seconds.
 */
export async function chunkFile(file, { emit, onProgress: report, pieceFor, signal, log = () => {} }) {
  if (!OAC()) throw new AudioError("הדפדפן הזה לא תומך בעיבוד שמע. נסו Chrome, Edge, Firefox או Safari עדכניים.");
  const kind = await sniff(file);
  log("סוג קובץ: " + kind);
  const chunker = new Chunker(emit, pieceFor);
  const onProgress = (f, d) => { if (d) chunker.setDuration(d); report?.(f, d); };
  const check = () => { if (signal?.aborted) throw abortErr(); };
  let done = false;
  try {
    if (kind === "mp3") {
      const info = await mp3Info(file);
      if (info) {
        onProgress?.(0, info.duration);
        let n = 0;
        for await (const { a, b } of mp3Segments(file, info)) {
          check();
          let ab = await file.slice(a, b).arrayBuffer();
          const buf = await decode16k(ab); ab = null;
          await chunker.push(mono(buf)); n++;
          onProgress?.((b - info.start) / (file.size - info.start), info.duration);
        }
        done = n > 0;
      }
    } else if (kind === "wav") {
      const info = await wavInfo(file);
      if (info) {
        onProgress?.(0, info.duration);
        const step = Math.max(info.align, Math.floor(info.byteRate * SEG / info.align) * info.align);
        for (let a = 0; a < info.data.sz; a += step) {
          check();
          const bytes = file.slice(info.data.o + a, info.data.o + Math.min(info.data.sz, a + step));
          const buf = await decode16k(await wavPiece(info, bytes).arrayBuffer());
          await chunker.push(mono(buf));
          onProgress?.(Math.min(1, (a + step) / info.data.sz), info.duration);
        }
        done = true;
      }
    } else if (kind === "mp4") {
      try { await decodeMp4(file, chunker, onProgress, signal); done = true; }
      catch (e) { if (e.name === "AbortError") throw e; if (chunker.t > 0 || chunker.fill > 0) throw e; log("mp4 path: " + e.message + " – falling back to full decode"); }
    }
  } catch (e) {
    if (e.name === "AbortError") throw e;
    if (chunker.t > 0 || chunker.fill > 0) throw new AudioError("פענוח הקובץ נכשל באמצע. נסו להמיר אותו ל-MP3 ולהעלות שוב.");
    log("segment path failed: " + (e.message || e) + " – trying full decode");
  }
  if (!done) {
    check();
    let ab = await file.arrayBuffer();
    let buf;
    try { buf = await decode16k(ab); }
    catch { throw new AudioError("הדפדפן לא הצליח לקרוא את הקובץ. ודאו שזה קובץ שמע או וידאו תקין, או המירו אותו ל-MP3."); }
    ab = null;
    const dur = buf.duration; onProgress?.(0, dur);
    let m = mono(buf); buf = null;
    const step = SR * 60;
    for (let o = 0; o < m.length; o += step) { check(); await chunker.push(m.subarray(o, o + step)); onProgress?.(Math.min(1, (o + step) / m.length), dur); }
    m = null;
  }
  const total = await chunker.end();
  if (total < 1) throw new AudioError("לא נמצא שמע בקובץ.");
  if (chunker.peak < 0.003) throw new AudioError("ההקלטה שקטה לגמרי – לא נמצא בה דיבור.");
  return total;
}
