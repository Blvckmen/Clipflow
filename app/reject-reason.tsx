"use client";
import { useEffect } from "react";
import { X } from "lucide-react";
import { REJECT_REASONS } from "../lib/reject-reasons.mjs";

// Shown for a few seconds after a clip is rejected: one tap says why (lib/reject-reasons.mjs). It never blocks, so
// swiping through clips isn't slowed down; rejecting the next clip simply asks about that one instead.
export function RejectReasonBar({ onPick, onDismiss }: { onPick: (reason: string) => void; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 15_000); return () => clearTimeout(t); }, [onDismiss]);
  return <div className="reject-why" role="dialog" aria-label="Why was this clip rejected?">
    <span>Why?</span>
    {Object.entries(REJECT_REASONS).map(([key, label]) => <button key={key} type="button" className="secondary" onClick={() => onPick(key)}>{label}</button>)}
    <button type="button" className="icon-button" aria-label="Skip" title="Skip" onClick={onDismiss}><X size={15} /></button>
  </div>;
}

// "Rejected in the last 30 days: 5 boring moment · 2 bad subtitles", most common first; nothing until there's a reason.
export function RejectSummary({ counts }: { counts: Record<string, number> | undefined }) {
  const parts = Object.entries(counts ?? {}).filter(([k, n]) => k in REJECT_REASONS && n > 0).sort((a, b) => b[1] - a[1]);
  if (!parts.length) return null;
  return <p className="muted reject-summary">Why clips were rejected in the last 30 days: {parts.map(([k, n]) => n + " " + REJECT_REASONS[k as keyof typeof REJECT_REASONS].toLowerCase()).join(" · ")}</p>;
}
