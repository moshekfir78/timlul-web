# Container for a host that gives a public URL (e.g. a Hugging Face Docker Space).
# The Gemini key comes ONLY from the host's secret store as the GEMINI_API_KEY environment variable.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip
RUN useradd -m -u 1000 user
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt yt-dlp
COPY --chown=user server ./server
COPY --chown=user docs ./docs
USER user
ENV TIMLUL_DATA=/tmp/timlul TIMLUL_TRUST_XFF=1 PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT}"]
