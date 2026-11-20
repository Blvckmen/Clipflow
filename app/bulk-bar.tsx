"use client";
// The clip library's selection toolbar: what can be done to every ticked clip at once.
import { Check, CheckSquare, Send, Square, Subtitles, Trash2, Undo2, X } from "lucide-react";

export type BulkOp = "approve" | "reject" | "pending" | "captionsOn" | "captionsOff" | "frame";

export function BulkBar({ count, shown, allShown, busy, onSelectShown, onClear, onRun, onPost, onDelete }: {
  count: number; shown: number; allShown: boolean; busy: boolean;
  onSelectShown: () => void; onClear: () => void; onRun: (op: BulkOp, frame?: string) => void; onPost: () => void; onDelete: () => void;
}) {
  return <div className="bulk-bar" role="toolbar" aria-label="Actions for selected clips">
    <div className="bulk-count">
      <strong>{count} selected</strong>
      {!allShown && <button className="text-button" onClick={onSelectShown}><CheckSquare size={14} />Select all {shown} shown</button>}
      <button className="text-button" onClick={onClear}><Square size={14} />Clear</button>
    </div>
    <div className="bulk-actions">
      <button className="primary" disabled={busy} onClick={onPost}><Send size={14} />Post…</button>
      <button className="secondary" disabled={busy} onClick={() => onRun("approve")}><Check size={14} />Accept</button>
      <button className="secondary" disabled={busy} onClick={() => onRun("reject")}><X size={14} />Reject</button>
      <button className="secondary" disabled={busy} onClick={() => onRun("pending")} title="Move back to Needs review"><Undo2 size={14} />To review</button>
      <select aria-label="Edit selected clips" disabled={busy} value="" onChange={e => { const [op, frame] = e.target.value.split(":"); if (op) onRun(op as BulkOp, frame); }}>
        <option value="">Edit…</option>
        <option value="captionsOff">Remove subtitles</option>
        <option value="captionsOn">Add subtitles</option>
        <option value="frame:blur">Framing: blurred background</option>
        <option value="frame:crop">Framing: centre crop</option>
        <option value="frame:fit">Framing: fit with black bars</option>
        <option value="frame:split">Framing: split screen</option>
        <option value="frame:phone">Framing: phone stream (upright picture fills the frame)</option>
      </select>
      <button className="danger" disabled={busy} onClick={onDelete}><Trash2 size={14} />Delete</button>
    </div>
    <small className="bulk-note"><Subtitles size={12} />Edits re-render each clip from its original video; clips already posted keep their posted version.</small>
  </div>;
}
