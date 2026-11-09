"""Extract plain Hebrew text from an uploaded sources page (daf mekorot)."""
import os, re, subprocess
from . import gemini
import shutil
NOWIN = {}

PDFTOTEXT = shutil.which("pdftotext") or "/usr/bin/pdftotext"

IMG = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
       ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif"}
TEXT = {".txt", ".md", ".markdown", ".text"}
OCR_PROMPT = """זהו דף מקורות (דף מקורות לשיעור תורה) בעברית/ארמית.
העתק את כל הטקסט שבו במדויק, אות באות, כולל ניקוד אם יש, בסדר הקריאה הנכון (מימין לשמאל, עמודה אחר עמודה).
שמור על כותרות המקורות (שם הספר, פרק, פסוק, דף) בשורה נפרדת לפני כל מקור. אל תתרגם, אל תסכם ואל תוסיף הסברים.
החזר טקסט פשוט בלבד."""
FINALS = "ךםןףץ"


def _he(t):
    return len(re.findall(r"[א-ת]", t))


def _reversed(t):
    """pdftotext sometimes emits Hebrew in visual (reversed) order: final letters then show up at word starts."""
    words = re.findall(r"[א-ת]{2,}", t)
    start = sum(w[0] in FINALS for w in words); end = sum(w[-1] in FINALS for w in words)
    return start > end and start > 5


def _ocr(data, mime, log):
    text, model = gemini.generate([gemini.inline(data, mime), {"text": OCR_PROMPT}], gemini.CORRECT_PREF, max_tokens=32768, log=log)
    log(f"sources OCR via {model}")
    return text.strip()


def extract_file(path, log=print):
    """Return (text, note). note is a short Hebrew status string for the UI."""
    name = os.path.basename(path); ext = os.path.splitext(name)[1].lower()
    data = open(path, "rb").read()
    if ext in TEXT:
        return data.decode("utf-8", "replace").strip(), "טקסט"
    if ext == ".docx":
        import docx
        d = docx.Document(path)
        lines = [p.text for p in d.paragraphs]
        for tb in d.tables:
            for row in tb.rows:
                lines.append(" | ".join(c.text.strip() for c in row.cells))
        return "\n".join(l for l in lines if l.strip()).strip(), "Word"
    if ext in IMG:
        try:
            return _ocr(data, IMG[ext], log), "תמונה (זיהוי Gemini)"
        except Exception as e:
            return "", f"תמונה – זיהוי הטקסט נכשל: {str(e)[:120]}"
    if ext == ".pdf":
        txt = ""
        try:
            txt = subprocess.run([PDFTOTEXT, "-enc", "UTF-8", path, "-"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=120, **NOWIN).stdout
        except Exception:
            pass
        if not txt.strip():
            try:
                from pypdf import PdfReader
                txt = "\n".join((p.extract_text() or "") for p in PdfReader(path).pages)
            except Exception:
                txt = ""
        npages = max(1, txt.count("\f") + 1)
        scanned = _he(txt) < 80 * npages * 0.3 or _reversed(txt)
        if scanned and len(data) < 19 * 1024 * 1024:
            try:
                return _ocr(data, "application/pdf", log), "PDF (זיהוי Gemini)"
            except Exception as e:
                if not txt.strip():
                    return "", f"PDF סרוק – זיהוי הטקסט נכשל: {str(e)[:120]}"
        if _reversed(txt):  # no Gemini: best effort, flip each line
            txt = "\n".join(l[::-1] for l in txt.splitlines())
        return re.sub(r"\n{3,}", "\n\n", txt.replace("\f", "\n")).strip(), "PDF"
    try:
        return data.decode("utf-8").strip(), "טקסט"
    except UnicodeDecodeError:
        return "", "סוג קובץ לא נתמך"
