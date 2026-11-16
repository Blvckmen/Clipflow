"use client";
// The Analytics page: how posts are doing on the platforms (views, likes, comments, from Zernio about hourly) and
// what Clipflow did (clips captured and reviewed, posts published), overall, per streamer and per account.
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

type Num = number | null;
export type Analytics = {
  totals: { published: number; views: Num; likes: Num; comments: Num; shares: Num; saves: Num; measured: number; metrics_at: string | null; failed: number; waiting: number } | null;
  clips: { total: number; approved: Num; rejected: Num; pending: Num; chat: Num; audio: Num } | null;
  top: { id: string; clip_id: string; platform: string; permalink: string | null; published_at: string | null; views: Num; likes: Num; comments: Num; shares: Num; saves: Num; streamer: string | null; account: string | null }[];
  streamers: { id: string; name: string; platform: string; clips: number; approved: number; chat: number; posts: number; views: Num; likes: Num }[];
  accounts: { id: string; platform: string; username: string; posts: number; views: Num; likes: Num; comments: Num; failed: number }[];
  daily: { posts: { day: string; n: number }[]; clips: { day: string; n: number }[] };
  syncedAt: string | null; noAccess: boolean;
};

const compact = (n: Num) => n === null || n === undefined ? "—" : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const full = (n: Num) => n === null || n === undefined ? "—" : Intl.NumberFormat().format(n);
const day = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// One series of daily counts as thin bars; hovering a bar shows its day and value.
function DailyBars({ title, unit, data }: { title: string; unit: string; data: { day: string; n: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.n)), total = data.reduce((a, d) => a + d.n, 0);
  return <figure className="daily-bars">
    <figcaption><strong>{title}</strong><span>{total} in 14 days</span></figcaption>
    <div className="bars" role="img" aria-label={title + ": " + data.map(d => day(d.day) + " " + d.n).join(", ")}>
      {data.map(d => <div key={d.day} className="bar-slot" tabIndex={0} data-tip={day(d.day) + ": " + d.n + " " + unit + (d.n === 1 ? "" : "s")}>
        <div className="bar" style={{ height: d.n ? Math.max(4, (d.n / max) * 100) + "%" : 0 }} />
      </div>)}
    </div>
    <div className="bar-axis"><span>{day(data[0].day)}</span><span>{day(data[data.length - 1].day)}</span></div>
  </figure>;
}

export function AnalyticsView({ analytics, hasAccounts, brand, platformName, onConnect }: { analytics: Analytics | null; hasAccounts: boolean; brand: (name: string) => ReactNode; platformName: (p: string) => string; onConnect: () => void }) {
  if (!analytics?.totals || !analytics.clips) return <section className="panel"><div className="empty tall"><h3>Loading analytics…</h3></div></section>;
  const t = analytics.totals, c = analytics.clips;
  const engagement = t.views ? ((t.likes ?? 0) + (t.comments ?? 0) + (t.shares ?? 0) + (t.saves ?? 0)) / t.views : null;
  const status = analytics.noAccess ? "Your Zernio plan doesn't include analytics, so views and likes can't be read. Clipflow's own numbers below still update."
    : !t.published ? "Views, likes and comments appear here once clips are posted."
    : t.measured ? "Views, likes and comments come from the platforms through Zernio, refreshed about hourly" + (t.metrics_at ? "; last read " + when(t.metrics_at) : "") + "."
    : "Posts are published; their first numbers arrive within about an hour.";
  const tile = (label: string, value: string, detail: string) => <div className="metric"><div>{label}</div><strong>{value}</strong><p>{detail}</p></div>;
  return <>
    <div className="stats">
      {tile("Views", compact(t.views), t.measured ? "Across " + t.measured + " measured post" + (t.measured === 1 ? "" : "s") : "Not measured yet")}
      {tile("Likes", compact(t.likes), (t.comments ?? 0) + " comments · " + (t.shares ?? 0) + " shares · " + (t.saves ?? 0) + " saves")}
      {tile("Engagement rate", engagement === null ? "—" : (engagement * 100).toFixed(1) + "%", "Likes, comments, shares and saves per view")}
      {tile("Posts published", String(t.published), t.waiting + " waiting · " + t.failed + " failed")}
    </div>
    <p className="analytics-note">{status}</p>

    <div className="analytics-grid">
      <section className="panel"><div className="panel-heading"><div><h2>Activity</h2><p>Last 14 days (UTC)</p></div></div>
        <div className="daily-pair"><DailyBars title="Clips captured" unit="clip" data={analytics.daily.clips} /><DailyBars title="Posts published" unit="post" data={analytics.daily.posts} /></div></section>
      <section className="panel"><div className="panel-heading"><div><h2>Clips</h2><p>Everything the worker has captured</p></div></div>
        <div className="clip-breakdown">
          <div><strong>{c.total}</strong><span>captured</span></div>
          <div><strong>{c.approved ?? 0}</strong><span>accepted</span></div>
          <div><strong>{c.rejected ?? 0}</strong><span>rejected</span></div>
          <div><strong>{c.pending ?? 0}</strong><span>waiting for review</span></div>
          <div><strong>{c.chat ?? 0}</strong><span>from chat spikes</span></div>
          <div><strong>{c.audio ?? 0}</strong><span>from loud moments</span></div>
        </div></section>
    </div>

    <section className="panel analytics-table"><div className="panel-heading"><div><h2>Top posts</h2><p>Most viewed first</p></div></div>
      {analytics.top.length ? <div className="table-scroll"><table><thead><tr><th>Clip</th><th>Account</th><th>Posted</th><th className="num">Views</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Shares</th><th></th></tr></thead>
        <tbody>{analytics.top.map(p => <tr key={p.id}><td><strong>{p.streamer ?? "Removed streamer"}</strong></td><td><span className="inline-brand">{brand(platformName(p.platform))}@{p.account ?? "removed"}</span></td><td>{p.published_at ? when(p.published_at) : "—"}</td><td className="num">{full(p.views)}</td><td className="num">{full(p.likes)}</td><td className="num">{full(p.comments)}</td><td className="num">{full(p.shares)}</td><td>{p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">View <ExternalLink size={11} /></a>}</td></tr>)}</tbody></table></div>
        : <div className="empty"><p>Nothing posted yet.</p>{!hasAccounts && <button className="secondary" onClick={onConnect}>Connect an account</button>}</div>}
    </section>

    <div className="analytics-grid">
      <section className="panel analytics-table"><div className="panel-heading"><div><h2>By streamer</h2><p>Which channels make the clips that do well</p></div></div>
        {analytics.streamers.length ? <div className="table-scroll"><table><thead><tr><th>Streamer</th><th className="num">Clips</th><th className="num">Accepted</th><th className="num">Posts</th><th className="num">Views</th><th className="num">Views per post</th></tr></thead>
          <tbody>{analytics.streamers.map(s => <tr key={s.id}><td><span className="inline-brand">{brand(s.platform)}<strong>{s.name}</strong></span></td><td className="num">{s.clips}</td><td className="num">{s.approved}</td><td className="num">{s.posts}</td><td className="num">{full(s.views)}</td><td className="num">{s.posts && s.views !== null ? full(Math.round(s.views / s.posts)) : "—"}</td></tr>)}</tbody></table></div>
          : <div className="empty"><p>No streamers yet.</p></div>}
      </section>
      <section className="panel analytics-table"><div className="panel-heading"><div><h2>By account</h2><p>How each account is doing</p></div></div>
        {analytics.accounts.length ? <div className="table-scroll"><table><thead><tr><th>Account</th><th className="num">Posts</th><th className="num">Views</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Failed</th></tr></thead>
          <tbody>{analytics.accounts.map(a => <tr key={a.id}><td><span className="inline-brand">{brand(platformName(a.platform))}@{a.username}</span></td><td className="num">{a.posts}</td><td className="num">{full(a.views)}</td><td className="num">{full(a.likes)}</td><td className="num">{full(a.comments)}</td><td className="num">{a.failed}</td></tr>)}</tbody></table></div>
          : <div className="empty"><p>No accounts connected.</p><button className="secondary" onClick={onConnect}>Connect an account</button></div>}
      </section>
    </div>
  </>;
}
