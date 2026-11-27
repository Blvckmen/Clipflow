// The editor timeline's geometry: every lane shares one scale. `width` is the visible lane width in pixels, `zoom`
// widens the lanes (1 = the whole source fits), `scroll` is how far the lanes are scrolled, in pixels.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Source seconds at a pixel position inside the visible lanes.
export function timeAtX(x, width, duration, zoom, scroll) {
  if (!(duration > 0) || !(width > 0)) return 0;
  return clamp(((x + scroll) / (width * zoom)) * duration, 0, duration);
}

// Pixel position (from the start of the zoomed lanes) of a time in source seconds.
export function xOf(t, width, duration, zoom) {
  return duration > 0 ? (t / duration) * width * zoom : 0;
}

// Seconds between ruler marks: the smallest round step that keeps marks at least 60px apart.
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function rulerStep(duration, width, zoom) {
  const perSecond = duration > 0 ? (width * zoom) / duration : 0;
  return STEPS.find(s => s * perSecond >= 60) ?? STEPS[STEPS.length - 1];
}

// Subtitle lines (cues, in seconds from the trim start) as blocks in source seconds.
export function cueBlocks(cues, trimStart) {
  return cues.map(c => ({ start: trimStart + c.start, end: trimStart + c.end }));
}
