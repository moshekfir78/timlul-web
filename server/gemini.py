"""Gemini client (server-side only).
The API key is read at runtime from the GEMINI_API_KEY environment variable or ~/.secrets/gemini.env.
It is never written to disk by this app, never logged, and never sent to the browser."""
import base64, os, re, threading, time
import requests

API = "https://generativelanguage.googleapis.com"
SECRETS = os.path.expanduser(os.environ.get("TIMLUL_GEMINI_ENV", "~/.secrets/gemini.env"))

# Stage 1 (audio -> raw text): the dedicated Gemini 3.5 transcription model first, then 3.5 multimodal models.
TRANSCRIBE_PREF = ["gemini-3.5-transcribe", "gemini-3.5-flash", "gemini-3.5-flash-lite",
                   "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-flash-latest"]
# Stage 2 (raw text + sources -> edited transcript): Gemini 3.5 first.
CORRECT_PREF = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash",
                "gemini-3.1-pro-preview", "gemini-pro-latest", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-2.5-flash"]


class GeminiError(RuntimeError):
    pass


def key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"].strip()
    try:
        with open(SECRETS, encoding="utf-8-sig") as f:
            m = re.search(r"GEMINI_API_KEY\s*=\s*['\"]?([^'\"\s]+)", f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def _req(method, url, **kw):
    k = key()
    if not k:
        raise GeminiError("השרת לא מוגדר עם מפתח Gemini")
    r = requests.request(method, url, headers={"x-goog-api-key": k}, timeout=kw.pop("timeout", 600), **kw)
    if r.status_code >= 400:
        msg = ""
        try: msg = r.json().get("error", {}).get("message", "")[:140]
        except Exception: pass
        raise GeminiError(f"{r.status_code} {msg}".strip())
    return r


_names = {"t": 0, "v": None}
_nlock = threading.Lock()


def available():
    """Live model names this key can call with generateContent (cached for an hour)."""
    with _nlock:
        if _names["v"] is None or time.time() - _names["t"] > 3600:
            try:
                ms = _req("GET", API + "/v1beta/models?pageSize=300", timeout=30).json().get("models", [])
                _names["v"] = {m["name"].split("/")[-1] for m in ms if "generateContent" in m.get("supportedGenerationMethods", [])}
            except Exception:
                _names["v"] = set()
            _names["t"] = time.time()
        return _names["v"]


def cascade(pref):
    names = available()
    if not names:
        return list(pref)
    out = [m for m in pref if m in names]
    return out or sorted((n for n in names if re.match(r"gemini-3\.\d+-flash$", n)), reverse=True)[:3]


_cool = {}  # model -> time until which it's skipped (quota / missing)


def _text(cand):
    out = []
    for p in cand.get("content", {}).get("parts", []):
        if p.get("thought"):
            continue
        if p.get("text"):
            out.append(p["text"])
        elif isinstance(p.get("audioTranscription"), dict):   # gemini-3.5-transcribe returns this part type
            out.append(p["audioTranscription"].get("text", ""))
    return "".join(out)


def generate(parts, pref, max_tokens=65536, log=print, timeout=600, tries=3, thinking="low"):
    """Try models in order (with short retries on overload). Returns (text, model)."""
    errs = []
    models = cascade(pref)
    live = [m for m in models if _cool.get(m, 0) < time.time()] or models
    for m in live:
        gc = {"temperature": 0}
        if not m.endswith("-transcribe"):
            gc["maxOutputTokens"] = max_tokens
            if thinking and re.match(r"gemini-3|gemini-(flash|pro)-latest", m):
                gc["thinkingConfig"] = {"thinkingLevel": thinking}   # editing needs little reasoning; default "high" is very slow
        body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": gc}
        for attempt in range(tries):
            try:
                log(f"{m} (attempt {attempt + 1})")
                j = _req("POST", f"{API}/v1beta/models/{m}:generateContent", json=body, timeout=timeout).json()
                c = (j.get("candidates") or [{}])[0]
                out = _text(c)
                if out.strip():
                    if errs: log("gemini fallbacks: " + ", ".join(errs))
                    return out, m
                errs.append(f"{m}:empty({c.get('finishReason', '?')})")
                break
            except GeminiError as e:
                code = str(e)[:3]
                errs.append(f"{m}:{code}")
                if code == "429": _cool[m] = time.time() + 10 * 60
                if code == "404": _cool[m] = time.time() + 6 * 3600
                if code in ("500", "503", "504") and attempt < tries - 1:
                    time.sleep(3 + 6 * attempt); continue
                break
            except requests.RequestException as e:
                errs.append(f"{m}:{type(e).__name__}")
                break
    raise GeminiError("Gemini לא זמין כרגע (" + ", ".join(errs[-6:]) + ")")


def inline(data: bytes, mime: str):
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
