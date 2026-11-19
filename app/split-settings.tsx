"use client";
// Settings → Split screen per streamer: turn split screen on for a streamer's new clips and choose its backgrounds,
// layout and background sound. It edits the split-screen part of the streamer's saved look (the same look the clip
// editor's "Use this look for … new clips" saves), keeping the rest of that look as it is.
import { useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { defaultStyle } from "../worker/edit.mjs";

type Background = { id: string; name: string; content_type?: string; duration?: number | null };
type Style = { frame: { mode: string; background: string | null; pool?: string[]; split: { share: number; top: string; divider: string | null; volume: number } }; captions: { y: number } } & Record<string, unknown>;
type Streamer = { id: string; name: string; platform: string; style?: unknown };

export function SplitSettings({ streamers, backgrounds, workspace, busy, onSave }: {
  streamers: Streamer[]; backgrounds: Background[]; busy: boolean;
  workspace: { framing: string; captions: boolean; style: unknown };
  onSave: (streamerId: string, style: Style) => Promise<unknown>;
}) {
  // A streamer's look: its own, else the workspace's, else the built-in one with the workspace's framing.
  const baseFor = (s: Streamer) => structuredClone((s.style ?? workspace.style ?? defaultStyle({ framing: workspace.framing, captions: workspace.captions })) as Style);
  if (!streamers.length) return null;
  return <section className="panel settings-panel split-settings">
    <div className="panel-heading"><div><h2>Split screen per streamer</h2><p>Put a background under each streamer&apos;s new clips and choose which ones. Backgrounds come from the library above; a streamer without its own set rotates through all of them.</p></div></div>
    <div className="split-rows">{streamers.map(s => <SplitRow key={s.id + ":" + JSON.stringify(s.style ?? null)} streamer={s} base={baseFor(s)} own={!!s.style} backgrounds={backgrounds} workspaceFraming={workspace.framing} busy={busy} onSave={style => onSave(s.id, style)} />)}</div>
    <div className="panel-foot"><span className="small-dot" />Applies to clips captured from now on. To change clips already in the library, select them there and use Edit → Framing, or open one in the editor.</div>
  </section>;
}

function SplitRow({ streamer, base, own, backgrounds, workspaceFraming, busy, onSave }: {
  streamer: Streamer; base: Style; own: boolean; backgrounds: Background[]; workspaceFraming: string; busy: boolean; onSave: (style: Style) => Promise<unknown>;
}) {
  const [on, setOn] = useState(base.frame.mode === "split"), [pool, setPool] = useState<string[]>(base.frame.pool ?? []);
  const [top, setTop] = useState(base.frame.split?.top ?? "stream"), [share, setShare] = useState(base.frame.split?.share ?? 0.5), [volume, setVolume] = useState(base.frame.split?.volume ?? 0);
  const [saving, setSaving] = useState(false);
  const dirty = on !== (base.frame.mode === "split") || JSON.stringify(pool) !== JSON.stringify(base.frame.pool ?? []) || top !== (base.frame.split?.top ?? "stream") || share !== (base.frame.split?.share ?? 0.5) || volume !== (base.frame.split?.volume ?? 0);
  const names = useMemo(() => backgrounds.filter(b => pool.includes(b.id)).map(b => b.name), [backgrounds, pool]);
  const save = async () => {
    const style = structuredClone(base);
    // Turning split screen off goes back to the workspace framing (or the blurred fill if that is split screen too).
    style.frame.mode = on ? "split" : base.frame.mode === "split" ? (workspaceFraming !== "split" ? workspaceFraming : "blur") : base.frame.mode;
    style.frame.pool = pool;
    style.frame.split = { ...style.frame.split, top, share, volume };
    // Captions sit on the seam in split screen, and back at the usual place without it.
    if (on && style.captions.y === 0.72) style.captions.y = 0.5;
    if (!on && base.frame.mode === "split" && style.captions.y === 0.5) style.captions.y = 0.72;
    setSaving(true);
    try { await onSave(style); } finally { setSaving(false); }
  };
  return <div className={"split-row" + (on ? " on" : "")}>
    <div className="split-who"><strong>{streamer.name}</strong><small>{streamer.platform}{own ? " · own look" : " · workspace look"}</small></div>
    <label className="switch-row"><input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} />Split screen</label>
    <details className="split-pool" aria-disabled={!on}>
      <summary>{pool.length ? names.join(", ") || pool.length + " backgrounds" : "Any background in the library"}</summary>
      <div className="split-pool-list">
        {backgrounds.length ? backgrounds.map(b => <label key={b.id}><input type="checkbox" disabled={!on} checked={pool.includes(b.id)} onChange={e => setPool(e.target.checked ? [...pool, b.id] : pool.filter(x => x !== b.id))} /><span>{b.name}<small>{b.content_type?.startsWith("image/") ? "image" : b.duration ? Math.round(b.duration) + "s video" : "video"}</small></span></label>)
          : <p className="muted">Upload backgrounds in the library above first.</p>}
        {pool.length > 0 && <button type="button" className="text-button" onClick={() => setPool([])}>Use any background in the library</button>}
      </div>
    </details>
    <label className="split-field">Layout<select disabled={!on} value={top} onChange={e => setTop(e.target.value)}><option value="stream">Stream on top</option><option value="background">Background on top</option></select></label>
    <label className="split-field">Stream size <span>{Math.round(share * 100)}%</span><input type="range" disabled={!on} min={0.3} max={0.8} step={0.05} value={share} onChange={e => setShare(Number(e.target.value))} /></label>
    <label className="split-field">Background sound <span>{volume ? Math.round(volume * 100) + "%" : "Off"}</span><input type="range" disabled={!on} min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))} /></label>
    <button type="button" className="primary" disabled={busy || saving || !dirty} onClick={() => void save()}>{saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}Save</button>
  </div>;
}
