"use client";
// The timeline: one scale for every lane (video with the trim, subtitles, opening title, transcript), zoomable and
// scrolled sideways, with one playhead across all of them. Clicking any lane jumps there. The trim handles and the
// title's right edge can be dragged; subtitles and words follow the transcript, so they only seek.
import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Scissors } from "lucide-react";
import { MAX_CLIP } from "../../worker/edit.mjs";
import { cueBlocks, rulerStep, timeAtX } from "./lanes.mjs";
import { clamp, fmt, type Bundle, type Change, type Edit, type Word } from "./types";

const ZOOMS = [1, 2, 4, 8];
export function Timeline({ bundle, edit, change, setTrim, seek, time, cues, words, cuts }: {
  bundle: Bundle; edit: Edit; change: Change; setTrim: (which: "start" | "end", t: number) => void; seek: (t: number) => void; time: number;
  cues: { start: number; end: number }[]; words: Word[]; cuts: number[][];
}) {
  const duration = bundle.source.duration || 1, len = edit.trim.end - edit.trim.start;
  const [zoom, setZoom] = useState(1), [width, setWidth] = useState(800);
  const scroller = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Zooming keeps the playhead in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (time / duration) * el.scrollWidth - el.clientWidth / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  const pct = (t: number) => (clamp(t, 0, duration) / duration) * 100 + "%";
  // A drag that started on a handle: every move reports the time under the pointer, until it's let go.
  const follow = (ev: React.PointerEvent<HTMLElement>, onMove: (t: number) => void) => {
    ev.stopPropagation(); ev.preventDefault();
    const el = inner.current;
    if (!el) return;
    const move = (m: PointerEvent) => { const r = el.getBoundingClientRect(); onMove(timeAtX(m.clientX - r.left, r.width, duration, 1, 0)); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const dragTrim = (which: "start" | "end", ev: React.PointerEvent<HTMLElement>) => follow(ev, t => setTrim(which, t));
  // The title's length: from the trim start to where its right edge is dropped (to the end: the whole clip).
  const dragTitle = (ev: React.PointerEvent<HTMLElement>) => follow(ev, t => change("hook-seconds", e => { const L = e.trim.end - e.trim.start, s = Math.round(clamp(t - e.trim.start, 1, L) * 2) / 2; return { ...e, hook: { ...e.hook, seconds: s >= L - 0.25 ? MAX_CLIP : s } }; }));
  const seekAt = (ev: React.PointerEvent<HTMLElement>) => { const r = ev.currentTarget.getBoundingClientRect(); seek(timeAtX(ev.clientX - r.left, r.width, duration, 1, 0)); };
  const step = rulerStep(duration, width, zoom), ticks = Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  const maxChat = Math.max(1, ...(bundle.signals?.chat ?? [0])), titleOn = !!edit.hook.text && edit.hook.on !== false;
  const keyTrim = (which: "start" | "end") => (ev: React.KeyboardEvent) => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); setTrim(which, edit.trim[which] + (ev.key === "ArrowLeft" ? -0.25 : 0.25)); } };

  return <div className="timeline">
    <div className="timeline-head">
      <span><Scissors size={14} /> {fmt(edit.trim.start)} – {fmt(edit.trim.end)} · {len.toFixed(1)}s</span>
      <span className="timeline-zoom">
        <button className="icon-button" aria-label="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => setZoom(z => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}><Minus size={14} /></button>
        <span>{zoom}×</span>
        <button className="icon-button" aria-label="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}><Plus size={14} /></button>
      </span>
    </div>
    <div className="timeline-grid">
      <div className="lane-labels" aria-hidden><span className="ruler-label" /><span>Video</span><span className="l-sub">Subtitles</span><span className="l-title">Title</span><span className="l-words">Transcript</span></div>
      <div className="lane-scroll" ref={scroller}>
        <div className="lane-inner" ref={inner} style={{ width: zoom * 100 + "%" }} onPointerDown={seekAt}>
          <div className="ruler">{ticks.map(t => <span key={t} style={{ left: pct(t) }}>{fmt(t).replace(/\.\d$/, "")}</span>)}</div>
          <div className="lane lane-video">
            <div className="heat-bars" aria-hidden>{Array.from({ length: Math.max(1, Math.ceil(duration)) }, (_, i) => { const e = bundle.signals?.energy[i] ?? 0, ch = (bundle.signals?.chat[i] ?? 0) / maxChat; return <span key={i} style={{ height: Math.max(6, e * 100) + "%", background: ch > 0.05 ? `color-mix(in srgb, #ff7a59 ${Math.round(ch * 100)}%, #4b5a6b)` : undefined }} />; })}</div>
            <div className="heat-shade" style={{ left: 0, width: pct(edit.trim.start) }} />
            <div className="heat-shade" style={{ left: pct(edit.trim.end), right: 0 }} />
            <div className="heat-range" style={{ left: pct(edit.trim.start), width: (len / duration) * 100 + "%" }}>
              <span className="handle start" role="slider" aria-label="Clip start" aria-valuenow={edit.trim.start} tabIndex={0} onPointerDown={ev => dragTrim("start", ev)} onKeyDown={keyTrim("start")} />
              <span className="handle end" role="slider" aria-label="Clip end" aria-valuenow={edit.trim.end} tabIndex={0} onPointerDown={ev => dragTrim("end", ev)} onKeyDown={keyTrim("end")} />
            </div>
            {cuts.map(([a, b]) => <div key={a} className="heat-cut" title={"Jump cut: " + (b - a).toFixed(1) + "s pause"} style={{ left: pct(edit.trim.start + a), width: ((b - a) / duration) * 100 + "%" }} />)}
          </div>
          <div className={"lane lane-sub" + (edit.captions.on ? "" : " off")}>{cueBlocks(cues, edit.trim.start).map(b => <span key={b.start} style={{ left: pct(b.start), width: ((b.end - b.start) / duration) * 100 + "%" }} />)}</div>
          <div className={"lane lane-title" + (titleOn ? "" : " off")}>{edit.hook.text && <span style={{ left: pct(edit.trim.start), width: (Math.min(edit.hook.seconds, len) / duration) * 100 + "%" }} title="Opening title: drag its right edge to change how long it shows"><i className="title-edge" role="slider" aria-label="Title length" aria-valuenow={Math.min(edit.hook.seconds, len)} tabIndex={0} onPointerDown={dragTitle} /></span>}</div>
          <div className="lane lane-words">{words.map((w, i) => <span key={i} className={w[2] ? "" : "hidden"} style={{ left: pct(w[0]) }} />)}</div>
          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  </div>;
}
