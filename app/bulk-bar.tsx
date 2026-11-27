"use client";
// The clip library's selection toolbar: what can be done to every ticked clip at once.
import { Check, CheckSquare, Send, Square, Subtitles, Trash2, Undo2, X } from "lucide-react";

export type BulkOp = "approve" | "reject" | "pending" | "captionsOn" | "captionsOff" | "hookOn" | "hookOff" | "textStyle" | "frame";

// lookFrom: the selected clips that can be edited, to copy one's subtitle and title look to the others.
export function BulkBar({ count, shown, allShown, busy, onSelectShown, onClear, onRun, onPost, onDelete, lookFrom = [] }: {
  count: number; shown: number; allShown: boolean; busy: boolean;
  onSelectShown: () => void; onClear: () => void; onRun: (op: BulkOp, frame?: string, from?: string) => void; onPost: () => void; onDelete: () => void;
  lookFrom?: { id: string; label: string }[];
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
      <select aria-label="Text on selected clips" disabled={busy} value="" onChange={e => { const [op, from] = e.target.value.split(":"); if (op) onRun(op as BulkOp, undefined, from); }}>
        <option value="">Text…</option>
        <optgroup label="Subtitles">
          <option value="captionsOn">Show subtitles</option>
          <option value="captionsOff">Hide subtitles</option>
        </optgroup>
        <optgroup label="Opening title">
          <option value="hookOn">Show opening title (writes one where there is none)</option>
          <option value="hookOff">Hide opening title (keeps its text)</option>
        </optgroup>
        <optgroup label="Subtitle and title look">
          <option value="textStyle">Reset to each channel&apos;s look</option>
          {lookFrom.length > 1 && lookFrom.map(c => <option key={c.id} value={"textStyle:" + c.id}>Copy the look of: {c.label}</option>)}
        </optgroup>
      </select>
      <select aria-label="Framing of selected clips" disabled={busy} value="" onChange={e => { const [op, frame] = e.target.value.split(":"); if (op) onRun(op as BulkOp, frame); }}>
        <option value="">Framing…</option>
        <option value="frame:blur">Blurred background</option>
        <option value="frame:crop">Centre crop</option>
        <option value="frame:fit">Fit with black bars</option>
        <option value="frame:split">Split screen</option>
        <option value="frame:phone">Phone stream (upright picture fills the frame)</option>
      </select>
      <button className="danger" disabled={busy} onClick={onDelete}><Trash2 size={14} />Delete</button>
    </div>
    <small className="bulk-note"><Subtitles size={12} />Text and framing changes re-render each clip from its original video; clips already posted keep their posted version.</small>
  </div>;
}
