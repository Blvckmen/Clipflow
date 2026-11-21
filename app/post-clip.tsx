"use client";
// The "Post" dialog: sends a clip's current version to the accounts you tick, as its first post or again after an
// edit. Each account shows what has happened to this clip there so far.
import { useState, type ReactNode } from "react";
import { ExternalLink, Inbox, Loader2, Send } from "lucide-react";

type Account = { id: string; platform: string; username: string; status: string };
type Post = { account_id: string; state: "queued" | "processing" | "published" | "failed" | "review" | "skipped"; permalink: string | null; published_at: string | null; created_at: string; round?: number };

export function PostClipForm({ accounts, posts, linked, rendering, busy, brand, platformName, onPost }: {
  accounts: Account[]; posts: Post[]; linked: string[]; rendering: boolean; busy: boolean;
  brand: (name: string) => ReactNode; platformName: (platform: string) => string; onPost: (ids: string[], draft: boolean) => void;
}) {
  const latest = (id: string) => posts.filter(p => p.account_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const inFlight = (id: string) => posts.some(p => p.account_id === id && (p.state === "queued" || p.state === "processing"));
  // Start with the accounts this streamer posts to, leaving out any already busy with this clip.
  const [chosen, setChosen] = useState<string[]>(() => accounts.filter(a => linked.includes(a.id) && a.status === "connected" && !inFlight(a.id)).map(a => a.id));
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const anyPosted = chosen.some(id => posts.some(p => p.account_id === id && p.state === "published"));
  if (!accounts.length) return <div className="subtle-note">Connect an account under Connections to post clips.</div>;
  const tiktokChosen = chosen.filter(id => accounts.find(a => a.id === id)?.platform === "tiktok").length;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onPost(chosen, false); }}>
    <div className="account-picker post-picker">{accounts.map(a => {
      const p = latest(a.id), busyHere = inFlight(a.id), off = a.status !== "connected";
      const note = off ? "Reconnect needed" : busyHere ? "On its way" : p?.state === "published" ? "Posted " + (p.published_at ? when(p.published_at) : "") : p?.state === "failed" ? "Last attempt failed" : p?.state === "review" ? "Held for review (daily limit reached); posting queues it" : p?.state === "skipped" ? "Skipped" : "Not posted yet";
      return <label key={a.id} className={busyHere || off ? "disabled" : ""}>
        <input type="checkbox" disabled={busyHere || off} checked={chosen.includes(a.id)} onChange={e => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter(x => x !== a.id))} />
        {brand(platformName(a.platform))}
        <span>@{a.username}<small>{note}{p?.state === "published" && p.permalink && <> · <a href={p.permalink} target="_blank" rel="noreferrer">view <ExternalLink size={10} /></a></>}</small></span>
      </label>;
    })}</div>
    {rendering && <div className="subtle-note">Your latest edit is still rendering. The post waits for it, so the new version goes out.</div>}
    {anyPosted && <div className="subtle-note">This posts a new copy; the earlier post stays up. Platforms may refuse an identical caption within a day, so consider changing it in the editor first.</div>}
    <div className="post-buttons">
      <button className="primary" type="submit" disabled={busy || !chosen.length}>{busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{anyPosted ? "Post again" : "Post now"}{chosen.length > 1 ? " to " + chosen.length + " accounts" : ""}</button>
      {/* TikTok only: the clip lands in the account's drafts in the TikTok app, to finish and post from there. */}
      <button className="secondary" type="button" disabled={busy || !tiktokChosen} title={tiktokChosen ? "Finish and post it from the TikTok app" : "Tick a TikTok account: drafts are a TikTok feature"} onClick={() => onPost(chosen, true)}><Inbox size={15} />Save to TikTok drafts{tiktokChosen > 1 ? " (" + tiktokChosen + ")" : ""}</button>
    </div>
  </form>;
}
