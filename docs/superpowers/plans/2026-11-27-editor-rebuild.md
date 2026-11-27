# Clip editor rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tabbed clip editor with a four-step editor (Cut & frame, Text, Extras, Review & post), a colour-coded zoomable timeline, saved versions, transport controls, layout warnings and transcript downloads.

**Architecture:** The editor moves from `app/clip-editor.tsx` into `app/editor/` as focused components; ClipEditor owns state and passes `edit`, `change` and `bundle` down as props. Preview drawing code moves unchanged into `app/editor/draw.ts`. Pure helpers are `app/editor/*.mjs` so `node --test` can import them, like `worker/edit.mjs`. Versions are a new D1 table written by the existing edit POST.

**Tech Stack:** React 19 (vinext/Next), TypeScript, Cloudflare D1, node:test.

**Spec:** `docs/superpowers/specs/2026-11-27-editor-rebuild-design.md`

## Global Constraints

- The Edit object and `normalizeEdit` in `worker/edit.mjs` do not change; the renderer is untouched.
- GET/POST `/api/clips/[id]/edit` keep their contract; POST additionally writes versions.
- Migration file: `drizzle/0049_clip_versions.sql`; keep the newest 20 versions per clip.
- Every control in today's editor survives (including bold, italic, shadow, line-up, title own style, Show opening title).
- Short copy only: no help paragraph longer than one sentence.
- Steps: `cut`, `text`, `extras`, `review`, labelled "Cut & frame", "Text", "Extras", "Review & post".
- Lane colours: subtitles `var(--lime)`, title `#ff7a59` (coral), transcript `#5aa9ff` (blue).
- `app/clip-editor.tsx` keeps exporting `default ClipEditor` and `TemplateGallery` (callers and harness).

## Review Focus

- A clip whose source is pruned or not stored: the editor still opens, steps that need the video say so in one line, Save stays disabled as today.
- Legacy clips (no transcript): Text step shows the existing one-line note; lanes for subtitles/transcript are empty, not broken.
- Restoring a version whose trim is outside the current source duration: it is normalised (clamped) client-side via the same rules as `setTrim`, never sent invalid.
- A save that conflicts (`rev` mismatch) must not write a version (versions are in the same guarded batch).
- Zoomed timeline: seeking by click must use the scrolled, zoomed width (tested in `lanes.mjs` `timeAtX`).

---

### Task 1: Saved versions (database + API)

**Files:**
- Create: `drizzle/0049_clip_versions.sql`, `app/api/clips/[id]/versions/route.ts`
- Modify: `db/schema.ts` (add `clipVersions`), `app/api/clips/[id]/edit/route.ts` (POST batch), `drizzle/meta/_journal.json`
- Test: `tests/versions.test.mjs` (pure `versionLabel`), `lib/versions.mjs`

**Interfaces:**
- Produces: `GET /api/clips/[id]/versions` → `{versions:{rev:number,createdAt:string,label:string}[]}`; `GET ?rev=N` → `{rev, edit}`; `versionLabel(edit): string` in `lib/versions.mjs`; `KEEP_VERSIONS = 20`.

- [ ] Step 1: test `versionLabel({trim:{start:0,end:32.4},frame:{mode:"cam",facecam:{place:"top"}},captions:{on:true},hook:{text:"x",on:true}})` equals `"32.4s · Top split · subtitles · title"`; with captions off and no hook text: `"32.4s · Top split"`.
- [ ] Step 2: run `node --test tests/versions.test.mjs` → fails (module missing).
- [ ] Step 3: implement `lib/versions.mjs` (`versionLabel` uses `templateOf` + TEMPLATES labels from `worker/edit.mjs`; `KEEP_VERSIONS`).
- [ ] Step 4: migration: table and index exactly as the spec; journal entry idx 49.
- [ ] Step 5: edit POST batch, after the guarded UPDATE: `INSERT … SELECT` of the old edit when `NOT EXISTS` a version for the clip (rev = old `edit_rev`); insert the new edit (rev = old+1) `WHERE changes()`-safe — write each insert as `INSERT INTO clip_versions … SELECT … FROM clips WHERE id=? AND owner=? AND edit_rev=?new` so a conflicting save inserts nothing; prune `DELETE … WHERE clip_id=? AND rev NOT IN (SELECT rev … ORDER BY rev DESC LIMIT 20)`.
- [ ] Step 6: versions route (owner-checked, no-store).
- [ ] Step 7: `node --test tests/versions.test.mjs` passes; `npx tsc --noEmit -p .` clean; apply migration to remote only during deploy.
- [ ] Step 8: commit.

### Task 2: Pure editor helpers

**Files:**
- Create: `app/editor/lanes.mjs`, `app/editor/warnings.mjs`
- Test: `tests/editor-helpers.test.mjs`

**Interfaces:**
- Produces: `timeAtX(x:number, width:number, duration:number, zoom:number, scroll:number): number`; `xOf(t, width, duration, zoom): number`; `cueBlocks(cues, trimStart): {start,end}[]` (source seconds); `rulerTicks(duration, zoom): number[]` (1/2/5/10/30 s steps so ≥ 60px apart at 800px base); `layoutWarnings({W,H}, boxes:{hook?,captions?}, safe:{top,right,bottom}): string[]` returning any of `"Title is close to the edge"`, `"Subtitles are under the app buttons"`, `"Title overlaps the subtitles"`.

- [ ] Step 1: tests: `timeAtX(400, 800, 40, 1, 0) === 20`; `timeAtX(400, 800, 40, 2, 800) === 30`; `xOf(30, 800, 40, 2) === 1200`; `rulerTicks(40,1)` steps by 5; overlap warning when boxes intersect; edge warning when hook.left < 24; bottom warning when captions.bottom > H - safe.bottom.
- [ ] Step 2: run → fail. Step 3: implement. Step 4: run → pass. Step 5: commit.

### Task 3: Editor split (no behaviour change)

**Files:**
- Create: `app/editor/types.ts`, `app/editor/draw.ts`, `app/editor/TemplateGallery.tsx`, `app/editor/ClipEditor.tsx`
- Modify: `app/clip-editor.tsx` → `export { default } from "./editor/ClipEditor"; export { TemplateGallery } from "./editor/TemplateGallery";`

- [ ] Move types, draw helpers and gallery verbatim; ClipEditor keeps today's markup for now.
- [ ] tsc clean, lint shows no new errors, gallery harness still renders. Commit.

### Task 4: New shell — step bar, stage, transport, warnings

**Files:**
- Create: `app/editor/Stage.tsx` (canvas, draw loop, drag, transport: play, time, loop, speed 0.5/1/1.5/2, mute, fullscreen, safe zones, warning chip), `app/editor/StepBar.tsx`
- Modify: `app/editor/ClipEditor.tsx`, `app/globals.css` (editor section)

**Interfaces:**
- Consumes: `layoutWarnings` (Task 2).
- Produces: `Stage` props `{bundle, edit, change, videoRef, step, words, tl, loop, onTime}`; Stage reports drawn boxes via `onBoxes({hook, captions})`.

- [ ] Loop off: playback stops at trim end instead of jumping back. Speed sets `video.playbackRate`. Keys 1–4 switch steps. Commit after tsc/lint.

### Task 5: Timeline lanes

**Files:** Create `app/editor/Timeline.tsx`; uses `lanes.mjs`.

- [ ] Ruler, Video (today's heat strip + trim handles + cuts), Subtitles, Title (right-edge drag → `hook.seconds`, undo key `"hook-seconds"`), Transcript; zoom − / + (1×–8×), scroll box, one playhead. Commit.

### Task 6: Step panels

**Files:** Create `app/editor/steps/CutFrame.tsx`, `steps/Text.tsx`, `steps/Extras.tsx`, `steps/Review.tsx`, `app/editor/More.tsx` (`<More>` disclosure, open state per step in component state).

- [ ] Cut & frame, Text (switch bar + three panels, downloads via `worker/transcript.mjs` if present, else hidden), Extras, Review (finished video `/api/clips/[id]/file?v=<rev>`, render state line, Approve/Reject via `/api/dashboard` `bulkClips` op approve/reject disabled while dirty or queued, post text, versions list with Open, Make a copy, Use this look). Every control from today's tabs is present (check against the old file line by line). Commit.

### Task 7: Verify in a browser and ship

- [ ] Harness with a real local clip and stubbed `/api/clips/x/edit`, `/versions`, `/file`: screenshots of each step at 1440×900 and 390×844. Fix what looks wrong.
- [ ] Full checks: tsc, lint (no new errors), `node --test "worker/test/*.test.mjs"`, `node --test tests/versions.test.mjs tests/editor-helpers.test.mjs`.
- [ ] Commit; deploy (migration 0049) on the user's word, after announcing to other sessions.
