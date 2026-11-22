"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronUp, Flame, Pencil, Undo2, Volume2, VolumeX, X } from "lucide-react";
import { viralityLabel } from "../lib/virality.mjs";

// Phone review: the clips waiting for review one at a time, full screen, best first. Swipe right (or Approve) to
// accept, left (or Reject) to reject, up (or Skip) to come back to it later. Undo takes the last decision back.
// Keys work too: → or Enter accepts, ← or R rejects, ↓ or Space skips, Esc closes.
type FeedClip = { id: string; streamer: string | null; created_at: string; duration: number; reason: string | null; score?: number; edit_rev: number };
type Review = "pending" | "approved" | "rejected";
const SWIPE = 90;

export function ReviewFeed({ clips, reasonLabels, onDecide, onEdit, onClose }: {
  clips: FeedClip[]; reasonLabels: Record<string, string>;
  onDecide: (id: string, review: Review) => void; onEdit: (id: string) => void; onClose: () => void;
}) {
  // The queue is fixed when the feed opens, so decisions don't reorder what's coming.
  const [queue] = useState(() => clips.map(c => c.id));
  const byId = useMemo(() => new Map(clips.map(c => [c.id, c])), [clips]);
  const [done, setDone] = useState<{ id: string; review: Review }[]>([]), [skipped, setSkipped] = useState<string[]>([]);
  const [muted, setMuted] = useState(true), [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const start = useRef<{ x: number; y: number } | null>(null), video = useRef<HTMLVideoElement>(null);
  const decided = new Set(done.map(d => d.id));
  // Next up: the first clip not decided, skipped ones last.
  const order = [...queue.filter(id => !skipped.includes(id)), ...skipped].filter(id => !decided.has(id) && byId.has(id));
  const current = order[0] ? byId.get(order[0]) : undefined, next = order[1] ? byId.get(order[1]) : undefined;
  const total = queue.length, position = Math.min(total, done.length + 1);

  const decide = useCallback((review: Review) => {
    if (!current) return;
    onDecide(current.id, review);
    setDone(d => [...d, { id: current.id, review }]);
    setSkipped(s => s.filter(x => x !== current.id));
  }, [current, onDecide]);
  const skip = useCallback(() => { if (current) setSkipped(s => [...s.filter(x => x !== current.id), current.id]); }, [current]);
  const undo = useCallback(() => {
    const last = done.at(-1);
    if (!last) return;
    onDecide(last.id, "pending");
    setDone(d => d.slice(0, -1));
  }, [done, onDecide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); decide("approved"); }
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "r") { e.preventDefault(); decide("rejected"); }
      else if (e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); skip(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, skip, undo, onClose]);
  // The page behind doesn't scroll while the feed is open.
  useEffect(() => { const prev = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = prev; }; }, []);

  const down = (e: React.PointerEvent) => { if ((e.target as HTMLElement).closest("button")) return; start.current = { x: e.clientX, y: e.clientY }; setDrag({ x: 0, y: 0, active: true }); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => { if (start.current) setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y, active: true }); };
  const up = () => {
    if (!start.current) return;
    const { x, y } = drag;
    start.current = null; setDrag({ x: 0, y: 0, active: false });
    if (x > SWIPE && Math.abs(x) > Math.abs(y)) decide("approved");
    else if (x < -SWIPE && Math.abs(x) > Math.abs(y)) decide("rejected");
    else if (y < -SWIPE) skip();
    else if (Math.abs(x) < 8 && Math.abs(y) < 8 && video.current) { const v = video.current; if (v.paused) void v.play(); else v.pause(); }
  };
  const hint = drag.x > 40 ? "approve" : drag.x < -40 ? "reject" : drag.y < -40 ? "skip" : "";
  const src = (c: FeedClip) => "/api/clips/" + c.id + "/file?v=" + c.edit_rev;

  return <div className="review-feed" role="dialog" aria-modal="true" aria-label="Review clips">
    <header className="feed-top">
      <button className="feed-icon" aria-label="Close review" onClick={onClose}><X size={22} /></button>
      <div className="feed-progress"><span>{current ? position + " of " + total : "Done"}</span><i style={{ width: (done.length / Math.max(1, total)) * 100 + "%" }} /></div>
      <button className="feed-icon" aria-label={muted ? "Turn sound on" : "Mute"} onClick={() => setMuted(m => !m)}>{muted ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
    </header>
    {current ? <>
      <div className={"feed-stage" + (hint ? " hint-" + hint : "")} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        style={{ transform: drag.active ? `translate(${drag.x}px, ${Math.min(0, drag.y)}px) rotate(${drag.x / 30}deg)` : undefined, transition: drag.active ? "none" : undefined }}>
        <video key={current.id} ref={video} src={src(current)} autoPlay loop playsInline muted={muted} preload="auto" />
        {hint && <span className="feed-stamp">{hint === "approve" ? "Approve" : hint === "reject" ? "Reject" : "Later"}</span>}
        <div className="feed-meta">
          {current.score != null && <span className={"score-badge " + viralityLabel(current.score).toLowerCase()} title="Virality score"><Flame size={11} />{current.score}</span>}
          <strong>{current.streamer ?? "Removed streamer"}</strong>
          <small>{[current.reason && (reasonLabels[current.reason] ?? current.reason), current.duration + "s", new Date(current.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })].filter(Boolean).join(" · ")}</small>
        </div>
      </div>
      {next && <video className="feed-preload" src={src(next)} preload="auto" muted aria-hidden />}
      <footer className="feed-actions">
        <button className="feed-btn reject" onClick={() => decide("rejected")}><X size={26} /><span>Reject</span></button>
        <button className="feed-btn skip" onClick={skip}><ChevronUp size={22} /><span>Later</span></button>
        <button className="feed-btn approve" onClick={() => decide("approved")}><Check size={26} /><span>Approve</span></button>
      </footer>
      <div className="feed-tools">
        <button disabled={!done.length} onClick={undo}><Undo2 size={15} />Undo</button>
        <button onClick={() => onEdit(current.id)}><Pencil size={14} />Edit</button>
      </div>
    </> : <div className="feed-empty">
      <Check size={40} />
      <h2>All caught up</h2>
      <p>{done.length ? `You approved ${done.filter(d => d.review === "approved").length} and rejected ${done.filter(d => d.review === "rejected").length}.` : "Nothing is waiting for review."}</p>
      <div className="feed-empty-actions">{done.length > 0 && <button className="secondary" onClick={undo}><Undo2 size={15} />Undo last</button>}<button className="primary" onClick={onClose}>Done</button></div>
    </div>}
  </div>;
}
