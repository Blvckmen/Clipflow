"use client";
// Publishing setup inside the dashboard: the workspace's Zernio keys (each a separate Zernio account with its own
// social accounts), buttons that connect each social platform (through that platform's own sign-in), and
// per-account posting options. Nothing here needs a code change or a redeploy.
import { useState, type ReactNode } from "react";
import { Check, ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { gapChoices, tiktokModes, tiktokPrivacy, youtubeVisibility, type AccountOptions } from "../lib/account-options";

export type ZernioKey = { id: string; label: string; created_at: string; last_error: string | null; accounts: number };
export type Publishing = { zernio: boolean; zernioSource: "workspace" | "site" | null; zernioKeys: ZernioKey[]; canSaveKey: boolean };
export type ZernioAccount = { id: string; platform: string; username: string; options: AccountOptions; zernio_key_id: string | null };
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
  const keys = publishing.zernioKeys;
  const [adding, setAdding] = useState(false), [key, setKey] = useState(""), [removing, setRemoving] = useState<string | null>(null), [target, setTarget] = useState("");
  const into = keys.find(k => k.id === target) ?? keys[0];
  const keyForm = <form className="key-form" onSubmit={async e => { e.preventDefault(); if (await mutate({ action: "addZernioKey", key })) { setKey(""); setAdding(false); } }}>
    <label>Zernio API key<input type="password" autoComplete="off" required minLength={10} placeholder="sk_…" value={key} onChange={e => setKey(e.target.value)} /></label>
    <button className="primary" type="submit" disabled={busy || !publishing.canSaveKey}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Add key</button>
    {keys.length > 0 && <button className="secondary" type="button" onClick={() => setAdding(false)}>Cancel</button>}
    <small>Find it on <a href="https://zernio.com/dashboard" target="_blank" rel="noreferrer">zernio.com <ExternalLink size={11} /></a> under Settings → API keys. Each key is a separate Zernio account with its own connected accounts. Keys are checked with Zernio and stored encrypted; they never reach your browser again.</small>
    {!publishing.canSaveKey && <small className="engine-error">This site can&apos;t store keys yet: its TOKEN_KEY secret is missing (see DEPLOY.md).</small>}
  </form>;
  // Accounts grouped by the key they were connected with (null: the site's shared key).
  const groups = [...keys.map(k => ({ id: k.id as string | null, label: k.label })), { id: null, label: "This site's shared key" }]
    .map(g => ({ ...g, accounts: accounts.filter(a => (a.zernio_key_id ?? null) === g.id) })).filter(g => g.accounts.length);

  return <section className="panel accounts-panel">
    <div className="panel-heading"><div><h2>Social accounts <span className="count">{accounts.length}</span></h2><p>Connect each account with its own sign-in. Each streamer posts only to the accounts you pick for it.</p></div>
      {publishing.zernio && <div className="connection-actions"><button className="secondary" disabled={busy} onClick={() => void mutate({ action: "syncZernio" })} title="Re-read your accounts from Zernio"><RefreshCw size={15} />Refresh</button></div>}</div>

    <div className="zernio-key">
      <KeyRound size={18} />
      <div>
        {keys.length > 0 && <><strong>Zernio keys <span className="count">{keys.length}</span></strong>
          <div className="key-list">{keys.map(k => <div key={k.id} className="key-row">
            <span><strong>{k.label}</strong><small className={k.last_error ? "engine-error" : "muted"}>{k.accounts} account{k.accounts === 1 ? "" : "s"}{k.last_error ? " · " + k.last_error : ""}</small></span>
            {removing === k.id
              ? <span className="key-confirm"><small>Remove this key and its {k.accounts} account{k.accounts === 1 ? "" : "s"} from Clipflow? They stay connected on Zernio.</small><button className="danger" disabled={busy} onClick={async () => { if (await mutate({ action: "removeZernioKey", id: k.id })) setRemoving(null); }}>Remove</button><button className="secondary" onClick={() => setRemoving(null)}>Cancel</button></span>
              : <button className="icon-button" aria-label={"Remove key " + k.label} title="Remove key" disabled={busy} onClick={() => setRemoving(k.id)}><Trash2 size={15} /></button>}
          </div>)}</div>
          {adding ? keyForm : <button className="text-button add-key" onClick={() => setAdding(true)}><Plus size={14} />Add another Zernio key</button>}</>}
        {!keys.length && (publishing.zernioSource === "site" && !adding
          ? <div className="zernio-key-line"><span>Posting through Zernio with this site&apos;s shared key.</span><button className="text-button" onClick={() => setAdding(true)}>Add your own key</button></div>
          : <><strong>Connect Zernio to post</strong><p className="muted">Zernio posts to TikTok, Instagram, YouTube and more for you, so there are no developer apps to set up. Create a free account, then paste its API key here. You can add more keys later.</p>{keyForm}</>)}
      </div>
    </div>

    {publishing.zernio && <div className="connect-section">
      {keys.length > 1 && <label className="connect-into">Add accounts under<select value={into?.id} onChange={e => setTarget(e.target.value)}>{keys.map(k => <option key={k.id} value={k.id}>{k.label} ({k.accounts})</option>)}</select></label>}
      <div className="connect-grid">{connectable.map(p => <a key={p.id} className="connect-tile" href={"/api/connections/zernio/start?platform=" + p.id + (into ? "&key=" + into.id : "")} target="_top">{brand(p.name)}<span><strong>{p.name}</strong><small>{p.note}</small></span><Plus size={15} /></a>)}</div>
    </div>}

    {groups.map(g => <div key={g.id ?? "site"} className="account-group">
      {(keys.length > 1 || (keys.length > 0 && g.id === null)) && <div className="account-group-title"><KeyRound size={13} />{g.label}</div>}
      <div className="account-list">{g.accounts.map(row)}</div>
    </div>)}
  </section>;
}

// The options dialog's body for one account.
export function AccountOptionsForm({ account, busy, workspaceLimit, onSave }: { account: ZernioAccount; busy: boolean; workspaceLimit: number; onSave: (options: Partial<AccountOptions>) => void }) {
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
  // How many and how often, for every platform.
  const pacing = <>
    <label>Daily limit<input type="number" min={1} max={100} placeholder={"Workspace setting (" + workspaceLimit + ")"} value={draft.dailyLimit ?? ""} onChange={e => set("dailyLimit", e.target.value === "" ? null : Math.max(1, Math.min(100, Math.round(Number(e.target.value)))))} />
      <small>Posts (drafts included) this account sends in any 24 hours. Leave empty to use the workspace limit from Settings.{account.platform === "tiktok" ? " TikTok itself takes about 15 direct posts a day through apps." : ""}</small></label>
    <label>Spacing<select value={draft.gapMinutes} onChange={e => set("gapMinutes", Number(e.target.value))}>{Object.entries(gapChoices).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>Spread posts through the day; a burst of posts usually reaches fewer people.</small></label>
    {account.platform === "tiktok" && <label className="check-row"><input type="checkbox" checked={draft.overflowToDrafts} onChange={e => set("overflowToDrafts", e.target.checked)} /><span>When the 15 direct posts are used up, send up to 5 more to my TikTok drafts<small>You finish those in the TikTok app; posting them yourself doesn&apos;t count against TikTok&apos;s app limit. Off: they wait for the next day.</small></span></label>}
  </>;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onSave(draft); }}>{fields}{pacing}<button className="primary" type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save options</button></form>;
}

// Every connected account has options now (daily limit and spacing at least).
export const hasOptions = (platform: string) => !!platform;
