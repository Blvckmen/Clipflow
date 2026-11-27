// Plain warnings about where the text sits, from the boxes the preview drew it in (canvas pixels) and the safe zones
// (pixels the apps cover at the top, right and bottom). Advice only: nothing is blocked.

export const EDGE = 24;
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const nearEdge = (b, W, H) => b.left < EDGE || b.right > W - EDGE || b.top < EDGE || b.bottom > H - EDGE;

export function layoutWarnings({ W, H }, { hook = null, captions = null }, safe) {
  const out = [];
  if (hook && nearEdge(hook, W, H)) out.push("Title is close to the edge");
  if (captions && nearEdge(captions, W, H)) out.push("Subtitles are close to the edge");
  else if (captions && captions.bottom > H - safe.bottom) out.push("Subtitles are under the app buttons");
  if (hook && captions && intersects(hook, captions)) out.push("Title overlaps the subtitles");
  return out;
}
