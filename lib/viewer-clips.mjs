// Viewers' Twitch clips settings. The workspace's preferences.import_clips is the fewest views a clip needs (0: off);
// preferences.viewer_clips holds the rest; a streamer's streamers.viewer_clips can override any of them.
//   perDay    most viewer clips made per streamer a day (they don't count toward the daily clip limit)
//   maxHours  only moments from the last this many hours (when they happened in the stream, not when clipped)
//   ask       "ask me first": the worker lists the clips it finds and makes only the ones picked
// The worker reads the same shapes (worker/core.mjs viewerClipSettings).
export const VIEWER_DEFAULTS = { perDay: 2, maxHours: 24, ask: false };
export const LIMITS = { minViews: [1, 100000], perDay: [1, 20], maxHours: [1, 72] };

const parse = json => { try { const v = typeof json === "string" ? JSON.parse(json) : json; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const int = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

// The workspace's settings, with defaults for anything missing or out of range.
export function readViewerClips(json) {
  const v = parse(json);
  return { perDay: int(v.perDay, LIMITS.perDay) ?? VIEWER_DEFAULTS.perDay, maxHours: int(v.maxHours, LIMITS.maxHours) ?? VIEWER_DEFAULTS.maxHours, ask: typeof v.ask === "boolean" ? v.ask : VIEWER_DEFAULTS.ask };
}

// A streamer's own choices: only the valid ones are kept; anything left out follows the workspace.
export function readStreamerViewerClips(json) {
  const v = parse(json), out = {};
  if (typeof v.on === "boolean") out.on = v.on;
  for (const k of ["minViews", "perDay", "maxHours"]) { const n = int(v[k], LIMITS[k]); if (n !== undefined) out[k] = n; }
  if (typeof v.ask === "boolean") out.ask = v.ask;
  return out;
}

// What applies to one streamer: { on, minViews, perDay, maxHours, ask }. Turning it on for a streamer while the
// workspace has it off needs that streamer's own minimum views (10 if none is set).
export function effectiveViewerClips(importClips, workspace, own) {
  const ws = readViewerClips(workspace), mine = readStreamerViewerClips(own);
  const on = mine.on ?? importClips > 0;
  return { on, minViews: mine.minViews ?? (importClips > 0 ? importClips : 10), perDay: mine.perDay ?? ws.perDay, maxHours: mine.maxHours ?? ws.maxHours, ask: mine.ask ?? ws.ask };
}
