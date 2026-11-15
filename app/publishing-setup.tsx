"use client";
// Publishing setup inside the dashboard: the workspace's Zernio key, buttons that connect each social platform
// (through that platform's own sign-in), and per-account posting options. Nothing here needs a code change or a
// redeploy.
import { useState, type ReactNode } from "react";
import { Check, ExternalLink, KeyRound, Loader2, Plus, RefreshCw } from "lucide-react";
import { tiktokModes, tiktokPrivacy, youtubeVisibility, type AccountOptions } from "../lib/account-options";

export type Publishing = { zernio: boolean; zernioSource: "workspace" | "site" | null; zernioLabel: string | null; canSaveKey: boolean };
export type ZernioAccount = { id: string; platform: string; username: string; options: AccountOptions };
type Mutate = (body: unknown) => Promise<unknown>;

// What can be connected, in the order shown. Ids are Zernio's platform names.
export const connectable: { id: string; name: string; note: string }[] = [
  { id: "tiktok", name: "TikTok", note: "Videos" },
  { id: "instagram", name: "Instagram", note: "Reels" },
  { id: "youtube", name: "YouTube", note: "Shorts" },
  { id: "facebook", name: "Facebook", note: "Page videos" },
  { id: "twitter", name: "X", note: "Video posts" },
  { id: "threads", name: "Threads", note: "Video posts" },
];

export function ZernioPanel({ publishing, accounts, busy, mutate, brand, row }: { publishing: Publishing; accounts: ZernioAccount[]; busy: boolean; mutate: Mutate; brand: (name: string) => ReactNode; row: (a: ZernioAccount) => ReactNode }) {
  const [editingKey, setEditingKey] = useState(false), [key, setKey] = useState("");
  const keyForm = <form className="key-form" onSubmit={async e => { e.preventDefault(); if (await mutate({ action: "zernioKey", key })) { setKey(""); setEditingKey(false); } }}>
    <label>Zernio API key<input type="password" autoComplete="off" required minLength={10} placeholder="sk_…" value={key} onChange={e => setKey(e.target.value)} /></label>
    <button className="primary" type="submit" disabled={busy || !publishing.canSaveKey}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save key</button>
    {editingKey && <button className="secondary" type="button" onClick={() => setEditingKey(false)}>Cancel</button>}
    <small>Find it on <a href="https://zernio.com/dashboard" target="_blank" rel="noreferrer">zernio.com <ExternalLink size={11} /></a> under Settings → API keys. It is checked with Zernio and stored encrypted; it never reaches your browser again.</small>
    {!publishing.canSaveKey && <small className="engine-error">This site can&apos;t store keys yet: its TOKEN_KEY secret is missing (see DEPLOY.md).</small>}
  </form>;

  return <section className="panel accounts-panel">
    <div className="panel-heading"><div><h2>Social accounts <span className="count">{accounts.length}</span></h2><p>Connect each account with its own sign-in. Each streamer posts only to the accounts you pick for it.</p></div>
      {publishing.zernio && <div className="connection-actions"><button className="secondary" disabled={busy} onClick={() => void mutate({ action: "syncZernio" })} title="Re-read your accounts from Zernio"><RefreshCw size={15} />Refresh</button></div>}</div>

    <div className="zernio-key">
      <KeyRound size={18} />
      {publishing.zernio && !editingKey
        ? <div className="zernio-key-line"><span>Posting through Zernio{publishing.zernioSource === "workspace" ? " as " + (publishing.zernioLabel ?? "your account") : " with this site's shared key"}.</span>
          <button className="text-button" onClick={() => setEditingKey(true)}>{publishing.zernioSource === "workspace" ? "Change key" : "Use my own key"}</button>
          {publishing.zernioSource === "workspace" && <button className="text-button" disabled={busy} onClick={() => void mutate({ action: "zernioKey", key: null })}>Remove key</button>}</div>
        : <div><strong>Connect Zernio to post</strong><p className="muted">Zernio posts to TikTok, Instagram, YouTube and more for you, so there are no developer apps to set up. Create a free account, then paste its API key here.</p>{keyForm}</div>}
    </div>

    {publishing.zernio && <div className="connect-grid">{connectable.map(p => <a key={p.id} className="connect-tile" href={"/api/connections/zernio/start?platform=" + p.id} target="_top">{brand(p.name)}<span><strong>{p.name}</strong><small>{p.note}</small></span><Plus size={15} /></a>)}</div>}

    {accounts.length > 0 && <div className="account-list">{accounts.map(row)}</div>}
  </section>;
}

// The options dialog's body for one account.
export function AccountOptionsForm({ account, busy, onSave }: { account: ZernioAccount; busy: boolean; onSave: (options: Partial<AccountOptions>) => void }) {
  const [draft, setDraft] = useState<AccountOptions>(account.options);
  const set = <K extends keyof AccountOptions>(k: K, v: AccountOptions[K]) => setDraft({ ...draft, [k]: v });
  const fields = account.platform === "tiktok" ? <>
    <label>When a clip is approved<select value={draft.tiktokMode} onChange={e => set("tiktokMode", e.target.value as AccountOptions["tiktokMode"])}>{Object.entries(tiktokModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>TikTok expects you to have seen each post. Drafts wait in the TikTok app for you to finish and publish.</small></label>
    <label>Who can watch<select value={draft.tiktokPrivacy} onChange={e => set("tiktokPrivacy", e.target.value as AccountOptions["tiktokPrivacy"])}>{Object.entries(tiktokPrivacy).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>Business accounts can only post publicly.</small></label>
    <label className="check-row"><input type="checkbox" checked={draft.allowComments} onChange={e => set("allowComments", e.target.checked)} /><span>Allow comments</span></label>
  </> : account.platform === "youtube" ? <label>Visibility<select value={draft.youtubeVisibility} onChange={e => set("youtubeVisibility", e.target.value as AccountOptions["youtubeVisibility"])}>{Object.entries(youtubeVisibility).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>The video title is the first line of the post caption.</small></label>
    : null;
  if (!fields) return <p className="muted">There are no extra options for this platform. Captions come from each clip, and the daily limit is under Settings.</p>;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onSave(draft); }}>{fields}<button className="primary" type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save options</button></form>;
}

export const hasOptions = (platform: string) => platform === "tiktok" || platform === "youtube";
