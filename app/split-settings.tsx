"use client";
// Settings → Split screen per streamer: turn split screen on for a streamer's new clips and choose its backgrounds,
// layout and background sound. It edits the split-screen part of the streamer's saved look (the same look the clip
// editor's "Use this look for … new clips" saves), keeping the rest of that look as it is.
//
// One card per streamer. The switch saves straight away; the details (backgrounds, layout, size, sound) are a draft
// with a live 9:16 preview until Save. "Copy to all" gives every other streamer the same split screen.
import { useMemo, useState } from "react";
import { ArrowDownUp, Check, ChevronDown, Copy, Film, ImageIcon, Loader2, RotateCcw, Shuffle, Volume2, VolumeX } from "lucide-react";
import { defaultStyle } from "../worker/edit.mjs";

type Background = { id: string; name: string; content_type?: string; duration?: number | null };
type Split = { share: number; top: string; divider: string | null; volume: number };
type Style = { frame: { mode: string; background: string | null; pool?: string[]; split: Split }; captions: { y: number; on?: boolean } } & Record<string, unknown>;
type Streamer = { id: string; name: string; platform: string; style?: unknown };
type Draft = { pool: string[]; top: string; share: number; volume: number };
type Save = (streamerId: string, style: Style, quiet?: boolean) => Promise<unknown>;

const FRAMING_NAMES: Record<string, string> = { blur: "Blurred background", crop: "Centre crop", fit: "Fit with black bars", split: "Split screen", cam: "Facecam on top", pip: "Facecam in corner", phone: "Phone stream" };
const PLATFORM_HUES: Record<string, string> = { Twitch: "#9146ff", Kick: "#53fc18", TikTok: "#fe2c55", YouTube: "#ff3d3d" };
const isImage = (b: Background) => !!b.content_type?.startsWith("image/");
const fileOf = (b: Background) => "/api/backgrounds/" + b.id + "/file";
const draftOf = (s: Style): Draft => ({ pool: s.frame.pool ?? [], top: s.frame.split?.top ?? "stream", share: s.frame.split?.share ?? 0.5, volume: s.frame.split?.volume ?? 0 });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const pct = (n: number) => Math.round(n * 100) + "%";

// The style to save: the base look with split screen on or off and the draft's settings.
function styleFor(base: Style, on: boolean, d: Draft, workspaceFraming: string): Style {
  const style = structuredClone(base), was = base.frame.mode === "split";
  // Turning split screen off goes back to the workspace framing (or the blurred fill if that is split screen too).
  style.frame.mode = on ? "split" : was ? (workspaceFraming !== "split" ? workspaceFraming : "blur") : base.frame.mode;
  style.frame.pool = d.pool;
  style.frame.split = { ...style.frame.split, top: d.top, share: d.share, volume: d.volume };
  // Captions sit on the seam in split screen (following it when the stream size or layout changes), and go back to
  // the usual place without it. Captions moved somewhere else in the editor stay where they were put.
  const seam = (x: Split | Draft) => Math.round((x.top === "background" ? 1 - x.share : x.share) * 100) / 100;
  const onSeam = (y: number) => y === 0.5 || (was && Math.abs(y - seam(base.frame.split)) < 0.011);
  if (on && (style.captions.y === 0.72 || onSeam(style.captions.y))) style.captions.y = seam(d);
  if (!on && was && onSeam(style.captions.y)) style.captions.y = 0.72;
  return style;
}

export function SplitSettings({ streamers, backgrounds, workspace, busy, onSave }: {
  streamers: Streamer[]; backgrounds: Background[]; busy: boolean;
  workspace: { framing: string; captions: boolean; style: unknown };
  onSave: Save;
}) {
  // A streamer's look: its own, else the workspace's, else the built-in one with the workspace's framing.
  const baseFor = (s: Streamer) => structuredClone((s.style ?? workspace.style ?? defaultStyle({ framing: workspace.framing, captions: workspace.captions })) as Style);
  const [copying, setCopying] = useState(false);
  if (!streamers.length) return null;
  const onCount = streamers.filter(s => baseFor(s).frame.mode === "split").length;
  // Every other streamer gets split screen with these settings; each keeps the rest of its own look.
  const copyToAll = async (from: string, d: Draft) => {
    setCopying(true);
    try { const others = streamers.filter(s => s.id !== from); for (const [i, s] of others.entries()) await onSave(s.id, styleFor(baseFor(s), true, d, workspace.framing), i < others.length - 1); }
    finally { setCopying(false); }
  };
  return <section className="panel settings-panel split-settings">
    <div className="panel-heading"><div>
      <h2>Split screen per streamer <span className="count">{onCount} of {streamers.length} on</span></h2>
      <p>Stack a background video or image under a streamer&apos;s new clips, the gameplay-under-the-talking look that keeps viewers watching. Each streamer can have its own backgrounds, layout and sound.</p>
    </div></div>
    <div className="split-cards">{streamers.map(s => <SplitCard key={s.id + ":" + JSON.stringify(s.style ?? null)} streamer={s} base={baseFor(s)} own={!!s.style}
      backgrounds={backgrounds} workspaceFraming={workspace.framing} busy={busy || copying} canCopy={streamers.length > 1}
      onSave={(style, quiet) => onSave(s.id, style, quiet)} onCopy={d => copyToAll(s.id, d)} />)}</div>
    <div className="panel-foot"><span className="small-dot" />Applies to clips captured from now on. To change clips already in the library, select them there and use Edit → Framing, or open one in the editor.</div>
  </section>;
}

function SplitCard({ streamer, base, own, backgrounds, workspaceFraming, busy, canCopy, onSave, onCopy }: {
  streamer: Streamer; base: Style; own: boolean; backgrounds: Background[]; workspaceFraming: string; busy: boolean; canCopy: boolean;
  onSave: (style: Style, quiet?: boolean) => Promise<unknown>; onCopy: (d: Draft) => Promise<void>;
}) {
  const on = base.frame.mode === "split", saved = draftOf(base);
  const [d, setD] = useState<Draft>(saved), [open, setOpen] = useState(on), [saving, setSaving] = useState<"" | "switch" | "save" | "copy">("");
  const dirty = !same(d, saved), set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }));
  // Backgrounds no longer in the library are dropped from the set.
  const pool = d.pool.filter(id => backgrounds.some(b => b.id === id));
  const chosen = useMemo(() => backgrounds.filter(b => pool.includes(b.id)), [backgrounds, pool]);
  const run = async (what: "switch" | "save" | "copy", job: () => Promise<unknown>) => { setSaving(what); try { await job(); } finally { setSaving(""); } };
  const toggle = () => { if (!on) setOpen(true); void run("switch", () => onSave(styleFor(base, !on, { ...d, pool }, workspaceFraming))); };
  const summary = on
    ? [d.top === "stream" ? "Stream on top" : "Background on top", "stream " + pct(d.share), chosen.length ? chosen.length + (chosen.length === 1 ? " background" : " backgrounds") : "any background", d.volume ? "sound " + pct(d.volume) : "sound off"].join(" · ")
    : "Off · " + (FRAMING_NAMES[base.frame.mode] ?? base.frame.mode);
  const hue = PLATFORM_HUES[streamer.platform] ?? "#bcfa76";
  return <article className={"split-card" + (on ? " on" : "") + (open && on ? " open" : "")}>
    <header className="split-card-head">
      <button type="button" className="split-card-title" disabled={!on} aria-expanded={open && on} onClick={() => setOpen(!open)}>
        <span className="split-avatar" style={{ background: hue + "22", color: hue }}>{streamer.name.slice(0, 1).toUpperCase()}</span>
        <span className="split-card-name"><strong>{streamer.name}</strong><small>{streamer.platform} · {own ? "own look" : "workspace look"}</small></span>
        <span className="split-card-summary">{summary}{dirty && on && <em> · unsaved</em>}</span>
        {on && <ChevronDown size={16} className="split-chevron" />}
      </button>
      <label className="split-switch" title={on ? "Turn split screen off for " + streamer.name : "Turn split screen on for " + streamer.name}>
        {saving === "switch" && <Loader2 size={14} className="spin" />}
        <input type="checkbox" role="switch" checked={on} disabled={busy || !!saving} onChange={toggle} aria-label={"Split screen for " + streamer.name} />
        <span className="split-track" aria-hidden="true" />
      </label>
    </header>
    {on && open && <div className="split-card-body">
      <Preview d={d} background={chosen[0] ?? backgrounds[0]} name={streamer.name} hue={hue} captionY={base.captions.on === false ? null : styleFor(base, true, d, workspaceFraming).captions.y} />
      <div className="split-controls">
        <div className="split-control">
          <span className="split-label">Layout</span>
          <div className="segmented split-layout" role="radiogroup" aria-label="Layout">
            {([["stream", "Stream on top"], ["background", "Background on top"]] as const).map(([v, label]) =>
              <button key={v} type="button" role="radio" aria-checked={d.top === v} className={d.top === v ? "active" : ""} onClick={() => set({ top: v })}>
                <span className={"layout-icon " + v} aria-hidden="true"><i /><i /></span>{label}
              </button>)}
          </div>
        </div>
        <div className="split-control split-sliders">
          <label><span className="split-label">Stream size <output>{pct(d.share)}</output></span>
            <input type="range" min={0.3} max={0.8} step={0.05} value={d.share} onChange={e => set({ share: Number(e.target.value) })} style={{ "--fill": ((d.share - 0.3) / 0.5) * 100 + "%" } as React.CSSProperties} />
            <span className="split-hint"><span>More background</span><span>More stream</span></span></label>
          <label><span className="split-label">Background sound <output>{d.volume ? pct(d.volume) : "Off"}</output></span>
            <span className="split-volume">
              <button type="button" className="icon-button" aria-label={d.volume ? "Mute background" : "Unmute background"} onClick={() => set({ volume: d.volume ? 0 : 0.3 })}>{d.volume ? <Volume2 size={15} /> : <VolumeX size={15} />}</button>
              <input type="range" min={0} max={1} step={0.05} value={d.volume} onChange={e => set({ volume: Number(e.target.value) })} style={{ "--fill": d.volume * 100 + "%" } as React.CSSProperties} />
            </span>
            <span className="split-hint"><span>The stream&apos;s own sound always plays</span></span></label>
        </div>
        <div className="split-control">
          <span className="split-label">Backgrounds <small>{pool.length ? "only the " + pool.length + " ticked" : "rotates through the whole library"}</small></span>
          {backgrounds.length ? <div className="split-tiles">
            <button type="button" className={"split-tile any" + (pool.length ? "" : " picked")} aria-pressed={!pool.length} onClick={() => set({ pool: [] })}>
              <span className="split-tile-media"><Shuffle size={18} /></span><span className="split-tile-name">Any</span>{!pool.length && <Check size={13} className="split-tick" />}
            </button>
            {backgrounds.map(b => { const picked = pool.includes(b.id); return <button key={b.id} type="button" className={"split-tile" + (picked ? " picked" : "")} aria-pressed={picked} title={b.name}
              onClick={() => set({ pool: picked ? pool.filter(x => x !== b.id) : [...pool, b.id] })}>
              <span className="split-tile-media">{isImage(b) ? <img src={fileOf(b)} alt="" loading="lazy" /> : <video src={fileOf(b) + "#t=1"} muted playsInline preload="metadata" />}
                <span className="split-tile-kind">{isImage(b) ? <ImageIcon size={11} /> : <Film size={11} />}{isImage(b) ? "" : b.duration ? Math.round(b.duration) + "s" : ""}</span></span>
              <span className="split-tile-name">{b.name}</span>{picked && <Check size={13} className="split-tick" />}
            </button>; })}
          </div> : <p className="split-empty">No backgrounds yet. <button type="button" className="text-button" onClick={() => document.querySelector(".background-library")?.scrollIntoView({ behavior: "smooth" })}>Upload some in the library above</button>, then pick them here.</p>}
          {pool.length > 0 && <small className="split-note">If none of these is long enough for a clip, any longer one from the library is used.</small>}
        </div>
        <footer className="split-actions">
          {canCopy && <button type="button" className="secondary" disabled={busy || !!saving} onClick={() => void run("copy", () => onCopy({ ...d, pool }))} title="Turn split screen on for every other streamer with these settings">
            {saving === "copy" ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}Copy to all streamers</button>}
          <span className="split-spacer" />
          {dirty && <button type="button" className="text-button" disabled={!!saving} onClick={() => setD(saved)}><RotateCcw size={13} />Undo changes</button>}
          <button type="button" className="primary" disabled={busy || !!saving || !dirty} onClick={() => void run("save", () => onSave(styleFor(base, true, { ...d, pool }, workspaceFraming)))}>
            {saving === "save" ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{dirty ? "Save changes" : "Saved"}</button>
        </footer>
      </div>
    </div>}
  </article>;
}

// A small 9:16 picture of the clip: the stream and the background stacked as the draft says, subtitles where they will be.
function Preview({ d, background, name, hue, captionY }: { d: Draft; background?: Background; name: string; hue: string; captionY: number | null }) {
  const stream = <div className="pv-stream" style={{ flexBasis: pct(d.share), background: `linear-gradient(160deg, ${hue}55, #0c0f13 75%)` }}>
    <span className="pv-live">LIVE</span><span className="pv-name">{name}</span>
  </div>;
  const bg = <div className="pv-bg" style={{ flexBasis: pct(1 - d.share) }}>
    {background ? isImage(background) ? <img src={fileOf(background)} alt="" /> : <video src={fileOf(background) + "#t=1"} muted loop autoPlay playsInline preload="metadata" />
      : <span className="pv-placeholder">Background</span>}
  </div>;
  return <figure className="split-preview" aria-label="Preview">
    <div className="pv-phone">{d.top === "stream" ? <>{stream}{bg}</> : <>{bg}{stream}</>}
      {captionY !== null && <span className="pv-caption" style={{ top: pct(captionY) }}>subtitles here</span>}
    </div>
    <figcaption><ArrowDownUp size={11} />{pct(d.share)} / {pct(1 - d.share)}</figcaption>
  </figure>;
}
