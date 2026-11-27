"use client";
import { useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";

// Settings → Your data: download everything this workspace holds, or delete all of it (app/api/account/*).
export function AccountData() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const remove = async () => {
    const typed = window.prompt("This deletes your whole workspace: channels, clips, recordings, posts, connected accounts, settings and plan. Posts already on TikTok, Instagram or YouTube stay there. It can't be undone.\n\nType DELETE to confirm.");
    if (typed !== "DELETE") return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "That didn't work. Try again.");
      window.top!.location.href = "/";
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <section className="panel settings-group"><div className="group-head"><Download size={18}/><div><h2>Your data</h2><p>Download what this workspace holds, or delete all of it.</p></div></div><div className="group-body">
    <p><a className="secondary" href="/api/account/export" download>Download my data</a><small> A JSON file of your channels, clips, posts and settings. Videos aren't in it; download those from the clip library.</small></p>
    <p><button type="button" className="danger" disabled={busy} onClick={remove}>{busy ? <Loader2 size={14} className="spin"/> : <Trash2 size={14}/>}Delete workspace</button><small> Deletes everything and cancels your plan. Posts already published on the platforms stay there.</small></p>
    {error && <p className="field-error" role="alert">{error}</p>}
  </div></section>;
}
