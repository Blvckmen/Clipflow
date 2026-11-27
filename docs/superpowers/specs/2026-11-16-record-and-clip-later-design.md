# Record now, clip later

## Why
Owners want to keep whole streams and choose clips afterwards, either to take load off the worker PC during a
stream or to pick moments themselves instead of trusting live detection.

## Approaches
- **Upload full recordings to R2**: watch at full quality in the dashboard, but hours of home upload and
  storage that grows without limit. Rejected.
- **Keep recordings only on the PC**: costs nothing, but moments are picked blind from a graph. Rejected.
- **Full recording on the PC, a small preview in R2 (chosen)**: the owner scrubs a ~200 MB/hour preview in the
  dashboard and the PC cuts the clip from the full-quality file.

## Behaviour
- Each streamer has a capture mode: `clip` (live clipping, as before), `record` (whole stream only; clips are
  chosen automatically when the stream ends) or `both`.
- The daily clip limit only limits clipping. Record and both keep recording after it is reached.
- When a recording ends, the worker joins its segments into `recording.mp4`, measures loudness for every second,
  and sends the dashboard a heat strip of loudness plus Twitch chat. Chat is logged live in every mode, and it is
  Twitch-only, as before.
- In the background, at low priority, the worker encodes a 360p preview and uploads it to R2 in 50 MB parts
  (R2 multipart, since Workers cap request bodies).
- `record` mode then picks the best moments (up to the daily limit) with the existing `pickWindow` logic and
  makes clips through the normal `processWindow` path. Those clips report and post like any other.
- **Recordings page**: a list of recordings, then a player for the preview with the heat strip underneath.
  The owner sets a start and an end (15–90 s) and clicks **Make clip**, or clicks **Find best moments**.
  Requests travel to the worker in the config poll. The resulting clip lands in the gallery with reason
  `manual` and opens in the editor.
- Recordings are deleted after `recording_days` (default 7, 1–30) on the PC (by the worker) and in R2 (by the
  cron). Deleting one in the dashboard removes it everywhere.
- Making a clip from a recording needs the PC to have the recording. If it doesn't, the request fails with a
  clear message.

## Builder's calls
- Data: `streamers.capture_mode`, `preferences.recording_days`, and tables `recordings` and `recording_requests`.
- The worker restarting mid-stream finalizes whatever segments exist. A stream that drops and comes back
  starts a new recording.
- Heat strip is bucketed so it has at most 2000 bars.
