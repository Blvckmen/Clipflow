# Clip editor rebuild — design

Date: 2026-11-27 · Owner: clipflow-9c · Status: waiting for approval

## Why

The user asked for the whole clip editor to be rebuilt along the lines of the "ClipFlow 2.0 Phase 13 Creator Studio"
prototype (Downloads/ClipFlow_2.0_Phase13_Master_Windows, a separate Python prototype, used as reference only), and for
its missing pieces to be added. Earlier feedback from the user: the editor shows too much text and looks too complex.
Success: the everyday path (trim, pick a template, check the text, save) is obvious without reading, and nothing the
editor can do today is lost.

## Goals

- A step-by-step editor: **1 Cut & frame → 2 Text → 3 Extras → 4 Review & post**, essentials visible, the rest behind
  "More controls" in each step.
- A colour-coded, zoomable timeline under the preview with one lane each for the video, subtitles, opening title and
  transcript.
- Saved versions: every save is kept; any earlier version can be opened again and saved as the newest.
- Review & post: the finished (rendered) video plays in the editor, with Approve / Reject next to it.
- Preview transport: loop on/off, playback speed, mute, fullscreen, safe zones.
- Plain warnings when text is close to the edge, under the app buttons, or overlapping other text.
- Subtitle downloads (SRT, VTT, TXT) and the transcript tools from clipflow-fe (find & replace, speaker names,
  re-sync), wired into the Text step.

## Non-goals

- Dragging or stretching single subtitle blocks on the timeline. Subtitles are worked out from the transcript words
  (worker/edit.mjs `cues`), so their timing changes by editing words, not blocks. The subtitle lane is seek-only.
- Multi-cut editing, keyframes, transitions, B-roll, audio waveforms, AI features, the Duo/Squad/Game UI templates.
- Any change to the edit data the worker renders (worker/edit.mjs `normalizeEdit`): workers on customer PCs update
  themselves on deploy, and the renderer must not change in this project.

## Anti-goals (a failure even if it works)

- More words on screen than today, or long help paragraphs.
- Any existing control disappears (including clipflow-fe's text style: bold, italic, shadow, line-up, the title's own
  style, and the Show opening title switch).
- Saves that used to conflict-check (`rev`) stop doing so, or renders change.

## Constraints

- Same Edit object, same GET/POST `/api/clips/[id]/edit` contract (one additive change: the POST also records a
  version).
- Other sessions: clipflow-fe owns `worker/transcript.mjs` (pure functions + tests) and any route they need; this
  project owns all editor UI. clipflow-6f's CSS stays at the end of `app/globals.css`.
- Migration number: 0049 (0048 is the last).
- React 19 lint rules (no ref reads during render, no setState straight inside effects).
- Must work at phone width (the editor already stacks).

## Approaches

1. **Rebuild clipflow's own editor around the Phase 13 flow (picked).** New component files, same data and save
   route, the existing preview drawing and template code moved over unchanged. The renderer and worker are untouched.
2. Port the prototype's `studio.js`. Rejected: vanilla JS for a different Python API and renderer, so it would be a
   rewrite anyway, and its controls don't match what clipflow renders.
3. Regroup today's tabs into steps inside the same file. Rejected: cheapest, but no real timeline lanes and the
   724-line file stays as it is.

The user handed over the how ("rebuild the whole editor and add the missing pieces"); approach 1 is the builder's
call.

## Layout

```
┌ ← Clips   Kai Cenat · 27 Nov 07:40 · 32.4s            ↶ ↷  ● Unsaved  [ Save & render ] ┐
│  ① Cut & frame   ② Text   ③ Extras   ④ Review & post                                    │
├──────────────────────────────┬───────────────────────────────────────────────────────────┤
│   ┌──────────┐               │  Step panel: the essentials                               │
│   │ preview  │  ⚠ Title too  │  …                                                        │
│   │  9:16    │    near edge  │  ▸ More controls                                          │
│   └──────────┘               │                                                           │
│ ▶ 0:12.4 / 0:32.4  ⟳ 1× 🔇 ⛶ ▢ │                                                           │
├──────────────────────────────┴───────────────────────────────────────────────────────────┤
│ 0:00      0:10      0:20      0:30   (ruler, zoom −/+)                                     │
│ Video     ▁▃▅▇▅▃[■■■■■■■■■■■■■■■■■■■]▃▁   loudness + chat, trim handles, jump cuts       │
│ Subtitles        [lime][lime] [lime][lime]                                                │
│ Title            [coral····]  ← drag the right edge for its length                       │
│ Transcript       ı ı ıı ı ı ıı ı ı ı ı (blue word ticks)                                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

At phone width the panel goes under the preview and the timeline under the panel.

## Steps

1. **Cut & frame** — start/end readout with "Set start" / "Set end" (at the playhead; I and O keys still work), clip
   shape, the template gallery, the chosen template's controls (webcam box, phone picture, split-screen background),
   zoom. More controls: left/right, up/down, brightness, contrast, saturation, reset.
2. **Text** — a switch bar: Subtitles (on/off) · Opening title (on/off) · Transcript. Clicking one opens its panel.
   - Subtitles: style presets, font, size, position. More: colours, outline, shadow, line-up, bold, italic, box, caps,
     key words, bleep.
   - Opening title: the text, "Write one for me", length. More: size, place, colours, background, line-up, caps, own
     style (font, bold, italic, shadow).
   - Transcript: click to jump, double-click to fix a word, restore original; clipflow-fe's find & replace, speaker
     names and re-sync; Download SRT / VTT / TXT.
3. **Extras** — jump cuts, punch-in zooms, chat on the clip, background music, progress bar.
4. **Review & post** — the finished video (`/api/clips/[id]/file`) with its render state ("Rendering your latest
   save…", "Up to date", "Not saved yet: Save & render first"); Approve / Reject (the dashboard's existing review
   actions); post text; Versions; Make a copy; "Use this look for X's new clips".

## Timeline

- Lanes share one horizontal scale; zoom (1×–8×) widens the lanes inside a scrolling box, ruler included. The playhead
  is one line across all lanes. Clicking any lane seeks.
- Video lane: today's heat strip (loudness bars, chat colour), shaded outside the trim, trim handles (drag, arrow
  keys), jump cuts marked.
- Subtitles lane: one lime block per subtitle line (`cues`), on the source time scale; seek-only.
- Title lane: one coral block from the trim start for `hook.seconds`; dragging its right edge sets the length (the same
  undo step rules as the slider). Hidden when the title is off or empty.
- Transcript lane: one blue tick per word, hidden words faded; seek-only.

## Saved versions

- Table `clip_versions` (migration 0049): `id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE
  CASCADE, owner TEXT NOT NULL, rev INTEGER NOT NULL, edit TEXT NOT NULL, created_at TEXT NOT NULL`, index on
  `(clip_id, rev)`.
- The edit POST, in the same batch as the update: if the clip has no versions yet, first keep the edit being replaced
  (its current `edit_rev`); then insert the new edit with the new rev; then delete all but the newest 20 for that clip.
- `GET /api/clips/[id]/versions` lists `{rev, createdAt, label}` newest first (label: a short summary, e.g. "32.4s ·
  Top split · subtitles on"); `?rev=N` returns that version's edit. Owner-checked like the edit route.
- Opening a version loads it into the editor as unsaved changes (undo works); Save & render makes it the newest
  version. Nothing is overwritten.
- Clips deleted from the dashboard take their versions with them (foreign key; to be confirmed that D1 enforces it on
  this database, else explicit deletes next to the two `DELETE FROM clips`).

## Warnings

Worked out from where the preview drew the text (the boxes `drawText` already returns) and the safe-zone rectangles:
"Title is close to the edge", "Subtitles are under the app buttons", "Title overlaps the subtitles". Shown as a small
chip by the preview, never blocking. Pure geometry in a tested helper.

## Files

- `app/clip-editor.tsx` → re-exports `app/editor/ClipEditor.tsx` (callers unchanged).
- `app/editor/`: `ClipEditor.tsx` (state, undo/redo, save, keyboard), `Stage.tsx` (draw loop, transport),
  `draw.ts` (wrap, drawText, drawChat, drawCam, drawTemplate — moved, not changed), `TemplateGallery.tsx`,
  `Timeline.tsx`, `steps/CutFrame.tsx`, `steps/Text.tsx`, `steps/Extras.tsx`, `steps/Review.tsx`, `warnings.ts`,
  `types.ts`.
- `app/api/clips/[id]/versions/route.ts`, the edit route's POST, `drizzle/0049_clip_versions.sql`, `db/schema.ts`.
- `app/globals.css`: the editor section rewritten in place.
- Tests: `tests/editor-warnings.test.mjs`, `tests/editor-timeline.test.mjs` (pure helpers), versions in
  `tests/api.test.mjs` if that suite covers the edit route.

## Verification

tsc clean; no new lint errors; worker tests unchanged; new unit tests; a browser harness with a real clip and stubbed
API (as for the template gallery) screenshotting each step at desktop and phone width; after deploy, open a real clip,
save, see a version appear, restore it.

## Left to the builder

Exact copy, icons, spacing; how "More controls" remembers its open state (per step, for the session); keyboard shortcut
additions (1–4 for steps); version labels' wording.
