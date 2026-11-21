"use client";
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronsUp, GripVertical, Loader2 } from "lucide-react";

export type Ranked = { id: string; name: string; platform: string; status: string; priority?: number | null; created_at?: string; capture_mode?: string };

// The worker's order: numbered streamers first (1 = recorded first), then any never placed, oldest first.
export function priorityOrder<T extends Ranked>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

const modeNote: Record<string, string> = { record: "records whole stream", both: "clips live + records" };

// Dialog body: put streamers in the order the worker should record them when more are live than it has room for.
export function RecordingPriority({ streamers, busy, error, brand, onSave, onClose }: { streamers: Ranked[]; busy: boolean; error?: string; brand: (platform: string) => ReactNode; onSave: (ids: string[]) => Promise<boolean>; onClose: () => void }) {
  const initial = priorityOrder(streamers).map(s => s.id);
  const [order, setOrder] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = new Map(streamers.map(s => [s.id, s]));
  const ids = order.filter(id => byId.has(id));
  const changed = ids.join() !== initial.join();
  const move = (id: string, to: number) => setOrder(list => { const rest = list.filter(x => x !== id); rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id); return rest; });
  return <>
    <h2>Recording priority</h2>
    <p>Your worker PC records a set number of streamers at once. When more are live than that, the ones higher on this list are recorded first. If someone higher up goes live while every slot is taken, the lowest-ranked one being recorded stops to make room. What it already recorded is kept.</p>
    <ol className="priority-list" aria-label="Streamers in recording order">
      {ids.map((id, i) => { const s = byId.get(id)!; return <li key={id} draggable className={dragging === id ? "dragging" : undefined}
        onDragStart={e => { setDragging(id); e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => setDragging(null)}
        onDragOver={e => { if (!dragging || dragging === id) return; e.preventDefault(); move(dragging, i); }}>
        <GripVertical size={15} className="priority-grip" aria-hidden />
        <span className="priority-rank">{i + 1}</span>
        {brand(s.platform)}
        <span className="priority-name"><strong>{s.name}</strong>{(s.status !== "armed" || modeNote[s.capture_mode ?? ""]) && <small>{[s.status === "paused" ? "paused" : s.status === "stopped" ? "stopped" : "", modeNote[s.capture_mode ?? ""] ?? ""].filter(Boolean).join(" · ")}</small>}</span>
        <span className="priority-moves">
          <button type="button" className="icon-button" disabled={i === 0} aria-label={"Move " + s.name + " to the top"} title="Move to the top" onClick={() => move(id, 0)}><ChevronsUp size={15} /></button>
          <button type="button" className="icon-button" disabled={i === 0} aria-label={"Move " + s.name + " up"} title="Move up" onClick={() => move(id, i - 1)}><ArrowUp size={15} /></button>
          <button type="button" className="icon-button" disabled={i === ids.length - 1} aria-label={"Move " + s.name + " down"} title="Move down" onClick={() => move(id, i + 1)}><ArrowDown size={15} /></button>
        </span>
      </li>; })}
    </ol>
    <small className="field-note">Drag a streamer, or use the arrows. Streamers you add later go to the bottom.</small>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="modal-actions">
      <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      <button type="button" data-enter className="primary" disabled={busy || !changed} onClick={async () => { if (await onSave(ids)) onClose(); }}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save order</button>
    </div>
  </>;
}
