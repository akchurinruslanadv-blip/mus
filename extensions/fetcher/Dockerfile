# extensions/fetcher/Dockerfile
FROM denoland/deno:2.0.0

# Install ffmpeg and python for 512D CLAP feature extraction
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Setup Python environment for CLAP
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir torch transformers soundfile numpy

ENV PYTHON_PATH=/app/.venv/bin/python
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

COPY . /app/extensions/fetcher
WORKDIR /app/extensions/fetcher

# Cache Deno dependencies
RUN deno cache src/server.ts

EXPOSE 8787
CMD ["deno", "task", "start"]

