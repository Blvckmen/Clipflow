FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python-is-python3 fonts-dejavu-core fonts-liberation ca-certificates \
 && pip install --no-cache-dir --break-system-packages streamlink faster-whisper opencv-python-headless \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json *.mjs *.py ./
USER node
VOLUME /data
ENV DATA_DIR=/data WHISPER_DIR=/data/models
CMD ["node", "main.mjs"]
