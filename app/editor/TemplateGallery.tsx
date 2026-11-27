"use client";
// The template gallery: one picture per template, made from the clip's current frame. The still is taken again when
// the video has moved to another frame, so the pictures follow what's on screen.
import { type RefObject, useEffect, useRef, useState } from "react";
import { DEFAULT_FACECAM, TEMPLATES, canvas as frameSize, stacks } from "../../worker/edit.mjs";
import { drawTemplate } from "./draw";
import type { CamBox, Frame } from "./types";

const TILE_W = 144, GUESS: CamBox = { x: 0.7, y: 0.04, w: 0.28, h: 0.38 };
export function TemplateGallery({ video, frame, face, active, onPick }: { video: RefObject<HTMLVideoElement | null>; frame: Frame; face: CamBox | null; active: string; onPick: (t: (typeof TEMPLATES)[number]) => void }) {
  const [still, setStill] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const take = () => {
      if (v.readyState < 2 || !v.videoWidth) return;
      const c = document.createElement("canvas"), s = Math.min(1, 640 / v.videoWidth);
      c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height); setStill(c);
    };
    // After a seek the new frame may not be decoded yet when the event fires (it comes out black): take it again a
    // little later too.
    let live = true;
    const later = () => { take(); for (const ms of [200, 800]) setTimeout(() => { if (live) take(); }, ms); };
    later();
    for (const ev of ["loadeddata", "seeked", "pause"]) v.addEventListener(ev, later);
    return () => { live = false; for (const ev of ["loadeddata", "seeked", "pause"]) v.removeEventListener(ev, later); };
  }, [video]);
  const flat = !stacks(frame);
  return <div className="template-gallery">{TEMPLATES.map(t => {
    const off = flat && (t.mode === "split" || t.mode === "cam");
    const f = { ...frame, mode: t.mode, zoom: 1, x: 0, y: 0, facecam: { ...DEFAULT_FACECAM, ...frame.facecam, box: frame.facecam?.box ?? face, ...("facecam" in t ? t.facecam : {}) } } as Frame;
    return <button key={t.id} type="button" className={"template-tile" + (active === t.id ? " active" : "")} disabled={off} title={off ? "Needs a portrait or square clip shape" : undefined} onClick={() => onPick(t)}>
      <TemplatePicture still={still} frame={f} />
      <span>{t.label}</span>
    </button>;
  })}</div>;
}
function TemplatePicture({ still, frame }: { still: HTMLCanvasElement | null; frame: Frame }) {
  const ref = useRef<HTMLCanvasElement>(null), { W, H } = frameSize(frame), h = Math.round(TILE_W * H / W);
  const key = JSON.stringify(frame);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    if (still) drawTemplate(ctx, still, frame, GUESS); else { ctx.fillStyle = "#1b2128"; ctx.fillRect(0, 0, TILE_W, h); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still, key, h]);
  return <canvas ref={ref} width={TILE_W} height={h} aria-hidden />;
}
