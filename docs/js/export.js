/* Downloads: Markdown, plain text and a real .docx (built here, no library). */
const TS = /^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/;
export function stripTs(md) { return md.split("\n").map((l) => l.replace(TS, "")).join("\n"); }

export function toTxt(md) {
  return md.split("\n").map((l) => {
    l = l.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[\?(.+?)\?\]/g, "$1(?)");
    if (/^#{1,6}\s+/.test(l)) return l.replace(/^#{1,6}\s+/, "").trim();
    if (/^>\s?/.test(l)) return "    " + l.replace(/^>\s?/, "");
    return l;
  }).join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---- minimal ZIP (store, no compression) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    parts.push(h.buffer, n, d);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    central.push(c.buffer, n);
    off += 30 + n.length + d.length;
  }
  const csize = central.reduce((s, x) => s + (x.byteLength ?? x.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
const x = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
function runs(text, extra = "") {
  const out = [];
  for (const [i, part] of text.split(/\*\*(.+?)\*\*/g).entries()) {
    if (!part) continue;
    const sub = part.split(/\[\?(.+?)\?\]/g);
    sub.forEach((p, k) => {
      if (!p) return;
      const rp = `<w:rPr><w:rtl/>${i % 2 ? "<w:b/><w:bCs/>" : ""}${k % 2 ? '<w:highlight w:val="yellow"/>' : ""}${extra}</w:rPr>`;
      out.push(`<w:r>${rp}<w:t xml:space="preserve">${x(p)}</w:t></w:r>`);
    });
  }
  return out.join("");
}
const P = (inner, ppr = "") => `<w:p><w:pPr><w:bidi/>${ppr}</w:pPr>${inner}</w:p>`;

export function toDocx(md, title) {
  const body = [];
  if (title) body.push(P(runs(title), '<w:pStyle w:val="Title"/>'));
  let quote = [];
  const flushQ = () => {
    if (!quote.length) return;
    quote.forEach((q, i) => body.push(P(runs(q), `<w:pStyle w:val="Quote"/>${i < quote.length - 1 ? '<w:spacing w:after="0"/>' : ""}`)));
    quote = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) { flushQ(); continue; }
    let m;
    if ((m = l.match(/^>\s?(.*)$/))) { quote.push(m[1]); continue; }
    flushQ();
    if ((m = l.match(/^#{1,6}\s+(.*)$/))) { body.push(P(runs(m[1]), '<w:pStyle w:val="Heading2"/>')); continue; }
    if ((m = l.match(/^[-•*]\s+(.*)$/))) { body.push(P(runs("• " + m[1]), '<w:ind w:left="360" w:right="360"/>')); continue; }
    if ((m = l.match(TS))) { body.push(P(`<w:r><w:rPr><w:color w:val="B02A50"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">[${x(m[1])}] </w:t></w:r>` + runs(l.replace(TS, "")))); continue; }
    body.push(P(runs(l)));
  }
  flushQ();
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`;
  const font = '<w:rFonts w:ascii="David" w:hAnsi="David" w:cs="David"/>';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="26"/><w:szCs w:val="26"/><w:lang w:val="he-IL" w:bidi="he-IL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/><w:jc w:val="both"/><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="320"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="5B3FD6"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="5B3FD6"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/><w:shd w:val="clear" w:color="auto" w:fill="F4EEE4"/></w:pPr><w:rPr><w:color w:val="3A2E1A"/><w:sz w:val="27"/><w:szCs w:val="27"/></w:rPr></w:style>
</w:styles>`;
  return zip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["word/document.xml", doc],
    ["word/styles.xml", styles],
  ]);
}
