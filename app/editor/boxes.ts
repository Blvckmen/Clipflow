// Starting boxes for the templates that need the clip's own rectangles (fractions of the stream), so picking one never
// falls back to the blurred fill: person 1 is the detected webcam (or a guess on the left), the others are mirrored
// and stacked guesses, and the game UI starts as a strip at the bottom middle. They're placed properly in the editor.
import { MULTI } from "../../worker/edit.mjs";
import type { CamBox, Frame } from "./types";

export const GUESS_LEFT: CamBox = { x: 0.02, y: 0.05, w: 0.26, h: 0.4 }, GUESS_UI: CamBox = { x: 0.35, y: 0.82, w: 0.3, h: 0.16 };
const mirror = (b: CamBox): CamBox => ({ ...b, x: Math.max(0, 1 - b.x - b.w) });
const lower = (b: CamBox): CamBox => ({ ...b, y: Math.min(1 - b.h, 0.55) });

export function withStartingBoxes(frame: Frame, face: CamBox | null | undefined): Frame {
  const need = (MULTI as Record<string, number>)[frame.mode] ?? 0, first = frame.facecam?.box ?? face ?? GUESS_LEFT;
  const facecam = { ...frame.facecam!, box: need || frame.mode === "gameui" ? first : frame.facecam?.box ?? null };
  const guesses = [mirror(first), lower(first), lower(mirror(first))], cams = [...(frame.cams ?? [])];
  while (cams.length < need - 1) cams.push(guesses[cams.length]);
  return { ...frame, facecam, cams, ui: frame.mode === "gameui" ? frame.ui ?? GUESS_UI : frame.ui ?? null };
}

// Every box a frame's template uses, with a label and colour for the box picker.
export type PickBox = { key: string; label: string; color: string; box: CamBox };
const COLORS = ["#bcfa76", "#5aa9ff", "#ff7a59", "#f2c94c"];
export function boxesOf(frame: Frame): PickBox[] {
  const need = (MULTI as Record<string, number>)[frame.mode] ?? 0, out: PickBox[] = [];
  const people = [frame.facecam?.box, ...(frame.cams ?? [])];
  const count = need || (frame.mode === "cam" || frame.mode === "pip" || (frame.mode === "gameui" && frame.uiCam) ? 1 : 0);
  for (let i = 0; i < count; i++) if (people[i]) out.push({ key: "p" + i, label: count > 1 ? "Person " + (i + 1) : "Webcam", color: COLORS[i], box: people[i]! });
  if (frame.mode === "gameui" && frame.ui) out.push({ key: "ui", label: "Game UI", color: "#c38bff", box: frame.ui });
  return out;
}
// A frame with one of its boxes moved or resized.
export function setBox(frame: Frame, key: string, box: CamBox): Frame {
  if (key === "ui") return { ...frame, ui: box };
  const i = Number(key.slice(1));
  if (i === 0) return { ...frame, facecam: { ...frame.facecam!, box } };
  const cams = [...(frame.cams ?? [])]; cams[i - 1] = box;
  return { ...frame, cams };
}
