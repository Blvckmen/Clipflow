"use client";
import { useState } from "react";
import { Bell, Check, Loader2, Send, Trash2 } from "lucide-react";

type Mutate = (body: unknown) => Promise<unknown>;

// Settings → Alerts: a Discord webhook that gets "clips are waiting for your review" (lib/alerts.ts). The link is
// stored encrypted and never shown again, so this only knows whether one is connected.
export function AlertsSettings({ on, error, busy, mutate }: { on: boolean; error: string | null; busy: boolean; mutate: Mutate }) {
  const [url, setUrl] = useState(""), [editing, setEditing] = useState(false);
  const connect = async () => { if (await mutate({ action: "discord", op: "connect", url })) { setUrl(""); setEditing(false); } };
  return <section className="panel settings-panel alerts-panel">
    <div className="panel-heading"><div><h2>Alerts</h2><p>Get a message in your Discord when clips are waiting for your review</p></div><Bell size={20} /></div>
    <div className="form-body">
      {on && !editing ? <>
        <p className="alerts-status"><span className="tag lime"><Check size={12} />Discord connected</span> At most one message every 10 minutes, saying how many clips are waiting, with a link here.</p>
        {error && <div className="error" role="alert">The last alert didn&apos;t arrive: {error}</div>}
        <div className="alerts-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void mutate({ action: "discord", op: "test" })}><Send size={14} />Send a test</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(true)}>Use another channel</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void mutate({ action: "discord", op: "remove" })}><Trash2 size={14} />Turn off</button>
        </div>
      </> : <form onSubmit={e => { e.preventDefault(); void connect(); }}>
        <label>Discord webhook link<input type="url" required autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" value={url} onChange={e => setUrl(e.target.value)} />
          <small>In your Discord server: Server Settings, Integrations, Webhooks, New Webhook, pick the channel, then Copy Webhook URL. It&apos;s stored encrypted and only used for these alerts. Anyone with the link can post in that channel, so don&apos;t share it.</small></label>
        <div className="alerts-actions">
          <button type="submit" className="primary" disabled={busy || !url.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Connect and send a test</button>
          {on && <button type="button" className="secondary" onClick={() => { setEditing(false); setUrl(""); }}>Cancel</button>}
        </div>
      </form>}
    </div>
  </section>;
}
