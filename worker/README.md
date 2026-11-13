# Clipflow worker

A long-running process that captures clips for one Clipflow user. It polls the
dashboard for that user's streamers and settings, records short clips from live
channels, and reports each finished clip back. Clip files stay on this machine.

## Run

1. In the dashboard, open **Connect worker** and create a token. It is shown once;
   creating another revokes the previous one.
2. Build and start the container:

```sh
docker build -t clipflow-worker .
docker run -d --name clipflow-worker -v clipflow-data:/data \
  -e CLIPFLOW_URL=https://your-site.example -e CLIPFLOW_TOKEN=cfw_... clipflow-worker
```

Without Docker, install Node 24+, ffmpeg, streamlink, and `pip install faster-whisper`,
then run `node main.mjs` with the same variables plus `DATA_DIR` pointing to a writable folder.

On Windows, `python` is often only the Microsoft Store alias: set `PYTHON=py`, make sure
Python's `Scripts` folder (which holds `streamlink.exe`) is on `PATH`, and set
`WHISPER_DIR` (for example `worker\data\models`), since the default is `/data/models`.

## Behaviour

- While control is running, checks each enabled streamer for a live stream every
  `LIVE_CHECK_SECONDS` (via `streamlink --json`, no download) and reports
  Live / Recording / Offline / Check failed to the dashboard. Only live streamers are recorded.
- Captures only while global control is **running** and the streamer is **enabled**.
  Control is re-read every poll; pausing or stopping cancels captures in progress.
  If the dashboard cannot be reached, all captures are cancelled.
- Each capture records 90–180 seconds, picks the loudest window (an audio-energy
  heuristic), crops to 720×1280, and optionally burns in Whisper captions.
- The daily limit caps clips per streamer per UTC day.
- An offline channel is retried with backoff (30s up to 5 min). After a successful
  clip the streamer waits `COOLDOWN_SECONDS` before the next capture.
- Each clip is reported, then its file is uploaded to the dashboard's storage so it can be
  watched and downloaded there (if storage is off, it stays local). Both are retried until
  accepted. Local files are deleted after `RETENTION_HOURS`; the dashboard copy is kept.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIPFLOW_URL` | required | Dashboard origin (https, or localhost) |
| `CLIPFLOW_TOKEN` | required | Worker token from the dashboard |
| `DATA_DIR` | `/data` | Clips and the local SQLite queue |
| `POLL_SECONDS` | `60` | How often to read control and settings |
| `COOLDOWN_SECONDS` | `600` | Wait between clips from one streamer |
| `RETENTION_HOURS` | `72` | How long clip files are kept |
| `MAX_CAPTURES` | `1` | Simultaneous captures |
| `LIVE_CHECK_SECONDS` | `120` | How often each streamer is checked for a live stream |
| `STREAMLINK` | `streamlink` | streamlink executable |
| `WHISPER_MODEL` | `tiny` | faster-whisper model for captions |
| `PYTHON` | `python` | Python executable |

Only capture channels you have permission to record and repost.

## Test

```sh
npm test                # scheduling, validation, framing, caption placement
npm run test:captions   # caption chunking (Python; on Windows: py test/test_captions.py)
```
