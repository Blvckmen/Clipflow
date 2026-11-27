// Drawing the preview on a canvas from the same layout and caption code (worker/edit.mjs) the worker renders with,
// so what you see is what gets posted.
import { CHAT_SIZE, KEYWORD_SCALE, RING, alignedX, camAreas, canvas as frameSize, facecamPlacement, layout, splitAreas } from "../../worker/edit.mjs";
import { clamp, type Box, type CamBox, type Facecam, type Frame } from "./types";

// Breaks words into lines no wider than `max` with the current font (or `measure`, for words drawn bigger).
function wrap(ctx: CanvasRenderingContext2D, words: string[], max: number, measure = (w: string, _i: number) => ctx.measureText(w).width) {
  const lines: number[][] = [];
  let line: number[] = [], width = 0;
  const space = ctx.measureText(" ").width;
  words.forEach((w, i) => {
    // A line break typed in the hook starts a new line.
    if (w === "\n") { if (line.length) lines.push(line); line = []; width = 0; return; }
    const ww = measure(w, i);
    if (line.length && width + space + ww > max) { lines.push(line); line = []; width = 0; }
    width += (line.length ? space : 0) + ww; line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

// Chat lines (name in its colour, then the message) stacked upwards from `bottom`, left-aligned at `x`, like the
// render's Chat style: Arial bold CHAT_SIZE with a 3px black outline. Lines don't wrap (the render's \q2).
export function drawChat(ctx: CanvasRenderingContext2D, lines: { name: string; text: string; color: string }[], x: number, bottom: number) {
  ctx.save();
  ctx.font = `bold ${CHAT_SIZE}px Arial, "DejaVu Sans", sans-serif`;
  ctx.textBaseline = "bottom"; ctx.textAlign = "left"; ctx.lineJoin = "round"; ctx.lineWidth = 6; ctx.strokeStyle = "#000000";
  const lh = CHAT_SIZE * 1.2;
  lines.forEach((l, i) => {
    const y = bottom - (lines.length - 1 - i) * lh, name = l.name + ":", rest = " " + l.text;
    ctx.strokeText(name, x, y); ctx.fillStyle = l.color; ctx.fillText(name, x, y);
    const nx = x + ctx.measureText(name).width;
    ctx.strokeText(rest, nx, y); ctx.fillStyle = "#ffffff"; ctx.fillText(rest, nx, y);
  });
  ctx.restore();
}

// The webcam cut out of the stream, at its place (see facecamPlacement): a white-bordered box or a circle in a white
// ring in the corner, like the render's.
export type Placement = { sx: number; sy: number; sw: number; sh: number; x: number; y: number; w: number; h: number };
export function drawCam(ctx: CanvasRenderingContext2D, src: CanvasImageSource, frame: Frame, fp: Placement) {
  if (frame.mode === "pip" && frame.facecam?.shape === "circle") {
    const r = fp.w / 2, cx = fp.x + r, cy = fp.y + r;
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(cx, cy, r + RING, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(src, fp.sx, fp.sy, fp.sw, fp.sh, fp.x, fp.y, fp.w, fp.h); ctx.restore();
    return;
  }
  if (frame.mode === "pip") { ctx.fillStyle = "#ffffff"; ctx.fillRect(fp.x - 4, fp.y - 4, fp.w + 8, fp.h + 8); }
  ctx.drawImage(src, fp.sx, fp.sy, fp.sw, fp.sh, fp.x, fp.y, fp.w, fp.h);
}

// A template's picture in the gallery: the clip's current frame (`still`, sw x sh) laid out the way the template
// would, scaled down to the tile. Webcam templates use the clip's webcam box, or a top-right guess without one.
// Background video shows a plain panel where the background goes.
export function drawTemplate(ctx: CanvasRenderingContext2D, still: HTMLCanvasElement, frame: Frame, guess: CamBox) {
  const { W, H } = frameSize(frame), sw = still.width, sh = still.height;
  ctx.save(); ctx.scale(ctx.canvas.width / W, ctx.canvas.height / H);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  const f = (frame.mode === "cam" || frame.mode === "pip") && !frame.facecam?.box ? { ...frame, facecam: { ...(frame.facecam as Facecam), box: guess } } : frame;
  const box = layout(f, sw, sh);
  if (f.mode === "split") {
    const a = splitAreas(f);
    ctx.save(); ctx.beginPath(); ctx.rect(0, a.stream.y, W, a.stream.h); ctx.clip(); ctx.drawImage(still, box.x, box.y + a.stream.y, box.w, box.h); ctx.restore();
    ctx.fillStyle = "#2a3340"; ctx.fillRect(0, a.background.y, W, a.background.h);
  } else if (f.mode === "cam" || f.mode === "pip") {
    const fp = facecamPlacement(f, sw, sh)!, game = f.mode === "cam" ? camAreas(f).game : { y: 0, h: H };
    ctx.save(); ctx.beginPath(); ctx.rect(0, game.y, W, game.h); ctx.clip(); ctx.drawImage(still, box.x, box.y + game.y, box.w, box.h); ctx.restore();
    drawCam(ctx, still, f, fp);
  } else {
    if (f.mode === "blur") {
      const cover = Math.max(W / sw, H / sh), cw = sw * cover, ch = sh * cover;
      ctx.filter = "blur(26px) brightness(0.86)"; ctx.drawImage(still, (W - cw) / 2 - 30, (H - ch) / 2 - 30, cw + 60, ch + 60); ctx.filter = "none";
    }
    ctx.drawImage(still, box.src.x, box.src.y, box.src.w, box.src.h, box.x, box.y, box.w, box.h);
  }
  ctx.restore();
}

// `margin` matches the subtitle style's left/right margins in buildAss (captions 40, hook 60), so lines wrap at
// the same width as in the render.
// A part with `big` (a caption keyword) is drawn KEYWORD_SCALE bigger, like its \fscx/\fscy in the render.
// bold, italic, shadow and align as in buildAss (left/right line up on that side of the wrap area, see alignedX).
export type TextLook = { font: string; size: number; outline: number; outlineColor: string; box: boolean; boxColor: string; bold?: boolean; italic?: boolean; shadow?: number; align?: string };
export function drawText(ctx: CanvasRenderingContext2D, parts: { t: string; color: string; big?: boolean }[], c: TextLook, cx: number, y: number, anchor: "middle" | "top", scale = 1, margin = 40, wrapWidth = cx * 2 - 2 * margin): Box {
  ctx.save();
  let left = Infinity, right = -Infinity;
  const font = (big?: boolean) => `${c.italic ? "italic " : ""}${c.bold === false ? "" : "bold "}${big ? Math.round(c.size * KEYWORD_SCALE) : c.size}px "${c.font}", "DejaVu Sans", Arial, sans-serif`;
  const shadow = c.shadow ?? 0, shade = (on: boolean) => { ctx.shadowColor = on && shadow ? "rgba(0,0,0,0.5)" : "transparent"; ctx.shadowOffsetX = ctx.shadowOffsetY = on ? shadow : 0; };
  ctx.font = font();
  ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const measure = (t: string, i: number) => { if (!parts[i]?.big) return ctx.measureText(t).width; ctx.font = font(true); const w = ctx.measureText(t).width; ctx.font = font(); return w; };
  const lines = wrap(ctx, parts.map(p => p.t), wrapWidth, measure), lh = c.size * 1.18, space = ctx.measureText(" ").width;
  const top = anchor === "middle" ? y - (lines.length * lh) / 2 : y;
  ctx.translate(cx, top + (lines.length * lh) / 2); ctx.scale(scale, scale); ctx.translate(-cx, -(top + (lines.length * lh) / 2));
  lines.forEach((line, li) => {
    const widths = line.map(i => measure(parts[i].t, i)), total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    const ly = top + li * lh + lh / 2;
    let x = alignedX(c.align ?? "center", cx, wrapWidth, total);
    left = Math.min(left, x); right = Math.max(right, x + total);
    if (c.box) { const pad = Math.max(8, Math.round(c.size * 0.22)); shade(true); ctx.fillStyle = c.boxColor; ctx.fillRect(x - pad, ly - lh / 2 - pad / 2 + 4, total + pad * 2, lh + pad - 8); shade(false); }
    line.forEach((i, k) => {
      ctx.font = font(parts[i].big);
      const outlined = !c.box && c.outline > 0;
      if (outlined) { shade(true); ctx.lineWidth = c.outline * 2; ctx.strokeStyle = c.outlineColor; ctx.strokeText(parts[i].t, x, ly); shade(false); }
      shade(!c.box && !outlined); ctx.fillStyle = parts[i].color; ctx.textAlign = "left"; ctx.fillText(parts[i].t, x, ly); shade(false);
      ctx.font = font();
      x += widths[k] + space;
    });
  });
  ctx.restore();
  // Where the text landed (before the pop scale), for dragging it and for the layout warnings.
  return { left, right, top, bottom: top + lines.length * lh };
}

export const pop = (since: number) => 0.82 + 0.18 * clamp(since / 0.11, 0, 1);
