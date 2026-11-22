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

Without Docker, install Node 24+, ffmpeg, streamlink, and `pip install faster-whisper opencv-python-headless`,
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
- New clips automatically get an opening hook title from the words inside their selected trim.
  It is generated after transcription, before the first render, while recording continues.
  The hook appears at the top for 3-6 seconds and is saved in the edit; change or clear it in
  **Clip library > Edit > Hook & extras**. This uses local excerpt selection, not an AI API.
  Transcription must be on; silence or unusable speech skips the hook. The subtitle profanity
  mask also applies to generated hooks. Saved edits are never given a replacement hook during
  re-rendering. This applies to clips made live and clips made from whole-stream recordings.
- Processing (transcription and rendering) runs one clip at a time; recording continues meanwhile.
- The daily limit caps clips per streamer per UTC day; reaching it ends that day's recording
  for streamers set to clip live only.
- **Whole-stream recordings** (a streamer's capture mode *Record the whole stream* or *Clip
  live and record*): every segment is kept under `DATA_DIR/recordings/<id>/`, at roughly
  1–3 GB an hour. When the stream ends, the segments are joined into `recording.mp4` (no
  re-encode), loudness is measured for every second, and the heat strip (plus Twitch chat)
  goes to the dashboard. A 360p preview (about 200 MB an hour, two encoder threads) is then
  uploaded in 48 MB parts so the stream can be watched in the dashboard's Recordings page.
  *Record* mode then clips the best moments, up to the daily limit. Clips picked in the
  dashboard (an exact range, or "find best moments") arrive with the config poll and are
  cut from the full-quality file here, so this machine must be on and still have the
  recording. Recordings are deleted after the workspace's retention (Settings, default
  7 days), or as soon as they're deleted in the dashboard. A worker restart mid-stream
  saves what was recorded so far.
- A recording that fails or ends is retried with backoff (30s up to 5 min) after a fresh live check.
- Each clip is reported, then its file is uploaded to the dashboard's storage so it can be
  watched and downloaded there (if storage is off, it stays local). Both are retried until
  accepted. Local files are deleted after `RETENTION_HOURS`; the dashboard copy is kept.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIPFLOW_URL` | required | Dashboard origin (https, or localhost) |
| `CLIPFLOW_TOKEN` | required | Worker token from the dashboard |
| `DATA_DIR` | `/data` | Clips and the local SQLite queue |
| `AUTO_HOOKS` | `true` | Automatic opening titles on new clips; set `false` to disable, then restart the worker |
| `POLL_SECONDS` | `60` | How often to read control and settings |
| `COOLDOWN_SECONDS` | `600` | Quiet time before a "loudest moment" clip is taken |
| `CHAT_CLIP_GAP_SECONDS` | `120` | Minimum time between chat-spike clips from one streamer |
| `CHAT_SPIKE_FACTOR` | `2.5` | How far above the typical chat rate counts as a spike |
| `BUFFER_SECONDS` | `240` | How much recent stream is kept on disk while recording |
| `RETENTION_HOURS` | `72` | How long clip files are kept |
| `MAX_CAPTURES` | `1` | Streamers recorded at the same time |
| `LIVE_CHECK_SECONDS` | `120` | How often each streamer is checked for a live stream |
| `STREAMLINK` | `streamlink` | streamlink executable |
| `WHISPER_MODEL` | `small` | faster-whisper model for transcripts (`tiny` is faster but much rougher on stream audio) |
| `WHISPER_THREADS` | `4` | CPU cores Whisper uses |
| `WHISPER_BEAM` | `1` | Whisper beam size (higher is slightly more accurate and much slower) |
| `WHISPER_CONTEXT` | `on` | `off` stops Whisper using earlier sentences as context: fewer repeats in very noisy audio, less punctuation |
| `AI_WRITER` | `on` | `off` stops the local AI writer; hooks and captions then come from the transcript alone |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model the AI writer uses (`ollama pull` it first); `qwen2.5:3b` is twice as fast with weaker hooks |
| `PYTHON` | `python` | Python executable |
| `TWITCH_CLIENT_ID` | none | Your Twitch app's Client ID, for importing viewers' Twitch clips (see below) |
| `TWITCH_CLIENT_SECRET` | none | That app's Client Secret. Keep it in `.env` on this PC; it never goes to the dashboard |
| `IMPORT_MINUTES` | `30` | How often viewers' Twitch clips are looked for |
| `YTDLP` | `yt-dlp`, then `python -m yt_dlp` | yt-dlp, for imported videos (needed for YouTube; see below) |

Only capture channels you have permission to record and repost.

## Viewers' Twitch clips (optional)

With Settings → "Viewers' Twitch clips" switched on, the worker looks every `IMPORT_MINUTES` for the most-viewed
clips viewers made in the last day on each running Twitch streamer's channel. It downloads them with streamlink and
turns them into clips in the streamer's look, the same way as clips it captures itself: transcribed, framed, and
sent for review or posting. It takes up to 2 a streamer at a time, within the daily clip limit, only clips at least
15 seconds long, and never the same one twice. Kick clips aren't imported.

It uses Twitch's official API with your own Twitch app (free, about 5 minutes to set up):

1. Sign in at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and choose **Register Your Application**.
2. Name: anything (for example "Clipflow worker"). OAuth Redirect URL: `http://localhost`. Category: **Application
   Integration**. Client Type: **Confidential**.
3. Open the app, copy its **Client ID**, choose **New Secret** and copy the secret.
4. Add both to this worker's `.env`, then restart the worker:

   ```sh
   TWITCH_CLIENT_ID=...
   TWITCH_CLIENT_SECRET=...
   ```

No one signs in to Twitch: the worker uses an app access token, which can only read public information like clips.

## Imported videos

Recordings → "Import a past stream or video" takes a Twitch past broadcast (`twitch.tv/videos/…`), a Kick past
broadcast (`kick.com/<channel>/videos/…`) or a YouTube video link. The worker downloads it (one at a time, at up to
720p) into a recording folder, then treats it like a recorded stream: loudness, heat strip, preview, and the clips
asked for (the best moments chosen when importing, or any picked later). A download stopped by a restart starts
again; deleting the recording in the dashboard cancels it.

Twitch and Kick videos download with streamlink. YouTube needs [yt-dlp](https://github.com/yt-dlp/yt-dlp), which is
also used for the others when installed (`py -m pip install yt-dlp`, then restart the worker).

## Suggested moments and game text on screen

Once a recording or imported video is saved, the worker suggests up to 12 moments for the pick list on Recordings
(loudness and chat), and you tick the ones to clip. After its preview is uploaded, it reads the screen around the
strongest parts for game banners (WASTED, MISSION PASSED, VICTORY ROYALE, YOU DIED…; big text only, not the HUD) and
sends the suggestions again with them; a banner counts as much as the loudest stretch. Reading the screen uses
[RapidOCR](https://github.com/RapidAI/RapidOCR) on the CPU (`py -m pip install rapidocr_onnxruntime`); about 15 to
20 minutes for a stream on a busy PC, whatever its length. Without it, suggestions use loudness and chat only.

## Background music (optional)

A clip's look can turn background music down ("Turn music down") or keep only the voice ("Voice only"), so
copyrighted music doesn't get clips muted or taken down (editor -> Extras -> Background music). The worker splits the
voice from everything else with [Demucs](https://github.com/adefossez/demucs) before rendering, once per clip (the
result is kept next to the clip's source). It needs PyTorch and Demucs, about 1 GB (CPU builds):

```sh
py -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
py -m pip install demucs
```

The first run downloads the model (about 80 MB). A 60-second clip takes 1 to 4 minutes on a laptop CPU. Without
Demucs, clips set to turn music down fail to render with a message saying so; clips that keep their sound don't need it.

## AI writer (optional)

With [Ollama](https://ollama.com) installed and a model pulled (`ollama pull qwen2.5:7b`), the worker asks it to write
each new clip's on-screen hook and post caption from the transcript, the stream title and (on Twitch) what chat said
at that moment. It runs on this machine: free and private, about 25 seconds per clip on a 4-core laptop CPU, plus about a minute the first time the model loads. If
Ollama isn't running, is slow or answers oddly, the clip keeps the transcript-based hook and caption, so nothing
waits on it.

## Test

```sh
npm test                # scheduling, validation, edit model (layout, captions, ffmpeg graph), highlight detection
npm run test:captions   # caption chunking (Python; on Windows: py test/test_captions.py)
```
