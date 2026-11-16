"use client";
// The "Edit streamer" dialog's body: name, channel URL, whether it is clipped, and which accounts post its clips.
import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { captureModes } from "../lib/clipflow";

type Streamer = { id: string; name: string; url: string; status: string; accounts: string[]; capture_mode?: string };
export type StreamerChanges = { name: string; url: string; status: string; accounts: string[]; captureMode: string };

export function StreamerForm({ streamer, hasAccounts, busy, picker, onSave }: {
  streamer: Streamer; hasAccounts: boolean; busy: boolean;
  picker: (value: string[], onChange: (next: string[]) => void) => ReactNode; onSave: (changes: StreamerChanges) => void;
}) {
  const [name, setName] = useState(streamer.name), [url, setUrl] = useState(streamer.url), [status, setStatus] = useState(streamer.status), [accounts, setAccounts] = useState(streamer.accounts), [mode, setMode] = useState(streamer.capture_mode ?? "clip");
  const moved = url.trim() !== streamer.url;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onSave({ name: name.trim(), url: url.trim(), status, accounts, captureMode: mode }); }}>
    <label>Display name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Channel URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.twitch.tv/channel" />
      <small>{moved ? "Changing it follows a different channel from the next check. Clips already captured stay with this streamer." : "Twitch, YouTube, Kick or TikTok LIVE."}</small></label>
    <label>Clipping<select value={status} onChange={e => setStatus(e.target.value)}>
      <option value="armed">Enabled: clip whenever they are live</option>
      <option value="paused">Paused</option>
      <option value="stopped">Stopped</option>
    </select></label>
    <label>When they go live<select value={mode} onChange={e => setMode(e.target.value)}>{Object.entries(captureModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>{mode === "clip" ? "Clips are cut while they stream." : mode === "record" ? "The whole stream is saved on your worker PC (about 1 to 3 GB an hour) and clipped when it ends. Pick your own clips under Recordings." : "Clips are cut while they stream, and the whole stream is saved so you can pick more later."}{mode !== (streamer.capture_mode ?? "clip") ? " Applies from their next stream." : ""}</small></label>
    {hasAccounts && <div><span className="field-label">Post clips to</span>{picker(accounts, setAccounts)}<small className="field-note">Leave all unticked to keep this streamer&apos;s clips in your library only.</small></div>}
    <button className="primary" type="submit" disabled={busy || !name.trim() || !url.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save changes</button>
  </form>;
}
