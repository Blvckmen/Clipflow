"use client";
// The box picker: the whole stream (a still of the current frame) with a coloured, labelled box for each webcam and
// the game UI the template uses. Drag a box to move it, drag its corner to resize it; with a box focused, the arrow keys
// move it and shift+arrows resize it. Boxes are fractions of the stream, like everywhere else.
import { type RefObject, useEffect, useRef } from "react";
import { useStill } from "./still";
import type { PickBox } from "./boxes";
import { clamp, type CamBox } from "./types";

const MIN = 0.05, STEP = 0.01;
const fit = (b: CamBox): CamBox => { const w = clamp(b.w, MIN, 1), h = clamp(b.h, MIN, 1); return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h }; };
const round = (b: CamBox): CamBox => ({ x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) });

export function BoxPicker({ video, boxes, onChange }: { video: RefObject<HTMLVideoElement | null>; boxes: PickBox[]; onChange: (key: string, box: CamBox) => void }) {
  const still = useStill(video), wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c || !still) return;
    c.width = still.width; c.height = still.height;
    c.getContext("2d")!.drawImage(still, 0, 0);
  }, [still]);
  // Moving (or resizing from the bottom-right corner) follows the pointer until it's let go.
  const drag = (ev: React.PointerEvent, b: PickBox, resize: boolean) => {
    ev.preventDefault(); ev.stopPropagation();
    const el = wrap.current;
    if (!el) return;
    const r = el.getBoundingClientRect(), x0 = ev.clientX, y0 = ev.clientY, start = b.box;
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - x0) / r.width, dy = (m.clientY - y0) / r.height;
      const next = resize ? { ...start, w: clamp(start.w + dx, MIN, 1 - start.x), h: clamp(start.h + dy, MIN, 1 - start.y) } : { ...start, x: start.x + dx, y: start.y + dy };
      onChange(b.key, round(fit(next)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const key = (ev: React.KeyboardEvent, b: PickBox) => {
    const d = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[ev.key];
    if (!d) return;
    ev.preventDefault(); ev.stopPropagation();
    const n = ev.shiftKey ? { ...b.box, w: b.box.w + d[0], h: b.box.h + d[1] } : { ...b.box, x: b.box.x + d[0], y: b.box.y + d[1] };
    onChange(b.key, round(fit(n)));
  };
  const aspect = still ? still.width + " / " + still.height : "16 / 9";
  return <div className="box-picker" ref={wrap} style={{ aspectRatio: aspect }}>
    <canvas ref={cv} aria-hidden />
    {boxes.map(b => <div key={b.key} className="pick-box" role="group" tabIndex={0} aria-label={b.label + ": drag to move, arrows to move, shift+arrows to resize"}
      style={{ left: b.box.x * 100 + "%", top: b.box.y * 100 + "%", width: b.box.w * 100 + "%", height: b.box.h * 100 + "%", borderColor: b.color, boxShadow: `0 0 0 9999px ${boxes.length === 1 ? "#0008" : "transparent"}` }}
      onPointerDown={ev => drag(ev, b, false)} onKeyDown={ev => key(ev, b)}>
      <span className="pick-label" style={{ background: b.color }}>{b.label}</span>
      <i className="pick-resize" style={{ background: b.color }} onPointerDown={ev => drag(ev, b, true)} />
    </div>)}
  </div>;
}
