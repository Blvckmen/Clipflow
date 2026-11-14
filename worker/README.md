# Clipflow worker

A long-running process that captures clips for one Clipflow user. It polls the
dashboard for that user's streamers and settings, records live channels into a
rolling buffer, clips highlights from it, and reports and uploads each clip.

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

### Windows, always on

1. Create `worker\.env` (git-ignored) with `CLIPFLOW_URL=https://your-site` and `CLIPFLOW_TOKEN=cfw_...`.
2. `powershell -ExecutionPolicy Bypass -File worker\install-windows.ps1` registers a "Clipflow worker"
   task that starts `run-windows.ps1` hidden at sign-in; start it now with
   `Start-ScheduledTask -TaskName 'Clipflow worker'`. `-Remove` unregisters it.
3. Keep the PC awake while plugged in (`powercfg /change standby-timeout-ac 0`) and check what closing
   the lid does; a sleeping PC records nothing.

`run-windows.ps1` uses `py` as Python, finds `streamlink.exe` in Python's Scripts folder, keeps data and
the Whisper model in `worker\data`, restarts the worker if it exits (backing off up to 5 minutes), and
logs to `worker\data\worker.log`.

## Behaviour

- While control is running, checks each enabled streamer for a live stream every
  `LIVE_CHECK_SECONDS` (via `streamlink --json`, no download) and reports
  Live / Recording / Offline / Check failed to the dashboard. Only live streamers are recorded.
- Records only while global control is **running** and the streamer is **enabled**.
  Control is re-read every poll; pausing or stopping ends recordings and cancels clip
  processing. If the dashboard cannot be reached, all recordings stop.
- A live streamer is recorded continuously into a rolling buffer of the last
  `BUFFER_SECONDS` (6-second segments on disk; older ones are deleted). Clips are cut
  from that buffer, so the moment that triggered a clip is never missed.
- **Chat spikes (Twitch):** chat is read anonymously. When the last 10 seconds have at
  least 6 messages and `CHAT_SPIKE_FACTOR` times the channel's typical 10-second count
  (median of the last 5 minutes), the worker waits 20 seconds, then clips from the
  window around it. At most one chat clip per `CHAT_CLIP_GAP_SECONDS`.
- **Loudest moment (all platforms):** if no clip was made for `COOLDOWN_SECONDS`, the
  loudest stretch of the recent buffer is clipped. Kick and YouTube rely on this alone,
  since reading their chat requires registered API apps.
- Within a window, the clip is placed by loudness plus chat activity 4 seconds later
  (viewers react after the moment), then its start and end move to the nearest sentence
  boundary in the transcript (within 4 seconds). The transcript is made once and reused
  for the captions. Clips are framed to 720×1280.
- Each clip keeps an unframed **source** (the moment plus 6 seconds either side) and its
  transcript. The clip is rendered from the source with an *edit* (`edit.mjs`): trim, framing,
  colour, caption style and animation, hook title and progress bar. The first edit uses the
  streamer's saved look, or the workspace's. The source is uploaded to the dashboard's storage
  so the clip can be edited there; when an edit is saved, the worker picks it up on its next
  config poll, re-renders the clip (`render.mjs`, from its local source or a downloaded copy)
  and uploads the result in place of the old file. Re-renders run even while automation is
  paused. Caption fonts must be installed on this machine (the Docker image ships DejaVu and
  Liberation, which stands in for Arial); a missing font falls back to a default one.
- Processing (transcription and rendering) runs one clip at a time; recording continues meanwhile.
- The daily limit caps clips per streamer per UTC day; reaching it ends that day's recording.
- A recording that fails or ends is retried with backoff (30s up to 5 min) after a fresh live check.
- Each clip is reported, then its file is uploaded to the dashboard's storage so it can be
  watched and downloaded there (if storage is off, it stays local). Both are retried until
  accepted. Local files are deleted after `RETENTION_HOURS`; the dashboard copy is kept.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIPFLOW_URL` | required | Dashboard origin (https, or localhost) |
| `CLIPFLOW_TOKEN` | required | Worker token from the dashboard |
| `DATA_DIR` | `/data` | Clips and the local SQLite queue |
| `POLL_SECONDS` | `60` | How often to read control and settings |
| `COOLDOWN_SECONDS` | `600` | Quiet time before a "loudest moment" clip is taken |
| `CHAT_CLIP_GAP_SECONDS` | `120` | Minimum time between chat-spike clips from one streamer |
| `CHAT_SPIKE_FACTOR` | `2.5` | How far above the typical chat rate counts as a spike |
| `BUFFER_SECONDS` | `240` | How much recent stream is kept on disk while recording |
| `RETENTION_HOURS` | `72` | How long clip files are kept |
| `MAX_CAPTURES` | `1` | Streamers recorded at the same time |
| `LIVE_CHECK_SECONDS` | `120` | How often each streamer is checked for a live stream |
| `STREAMLINK` | `streamlink` | streamlink executable |
| `WHISPER_MODEL` | `tiny` | faster-whisper model for captions |
| `PYTHON` | `python` | Python executable |

Only capture channels you have permission to record and repost.

## Test

```sh
npm test                # scheduling, validation, edit model (layout, captions, ffmpeg graph), highlight detection
npm run test:captions   # caption chunking (Python; on Windows: py test/test_captions.py)
```
