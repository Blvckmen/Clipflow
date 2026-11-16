"use client";
// The clip editor. The preview is drawn on a canvas from the same layout and caption code (worker/edit.mjs) the
// worker renders with, so what you see is what gets posted. Saving stores the edit; the worker re-renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Eye, EyeOff, Loader2, Pause, Play, Redo2, RotateCcw, Scissors, Sparkles, Undo2 } from "lucide-react";
import { ANIMATIONS, FONTS, H, MAX_CLIP, MIN_CLIP, PRESETS, W, activeCue, cues, layout } from "../worker/edit.mjs";

type Frame = { mode: "blur" | "crop" | "fit"; zoom: number; x: number; y: number };
type Captions = { on: boolean; preset: string; font: string; size: number; color: string; highlight: string; outline: number; outlineColor: string; box: boolean; boxColor: string; uppercase: boolean; animation: string; words: number; y: number; mask: boolean };
type Word = [number, number, string];
export type Edit = { v: number; trim: { start: number; end: number }; frame: Frame; look: { brightness: number; contrast: number; saturation: number }; captions: Captions; hook: { text: string; seconds: number; color: string; bg: string }; progress: { on: boolean; color: string }; words?: Word[] };
type Bundle = { id: string; streamerId: string; streamer: string | null; edit: Edit; rev: number; words: Word[]; signals: { energy: number[]; chat: number[] } | null; source: { width: number; height: number; duration: number }; legacy: boolean; sourceStored: boolean; render: { state: string | null; error: string | null; at: string | null }; createdAt: string; caption: { text: string | null; source: string | null; error: string | null; ai: boolean } };
type Tab = "frame" | "captions" | "extras" | "transcript" | "post";

const animationLabels: Record<string, string> = { none: "Static", pop: "Pop in", karaoke: "Karaoke", word: "One word at a time" };
const fmt = (t: number) => Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0");
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// Breaks words into lines no wider than `max` with the current font.
function wrap(ctx: CanvasRenderingContext2D, words: string[], max: number) {
  const lines: number[][] = [];
  let line: number[] = [], width = 0;
  const space = ctx.measureText(" ").width;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w).width;
    if (line.length && width + space + ww > max) { lines.push(line); line = []; width = 0; }
    width += (line.length ? space : 0) + ww; line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

// `margin` matches the subtitle style's left/right margins in buildAss (captions 40, hook 60), so lines wrap at
// the same width as in the render.
function drawText(ctx: CanvasRenderingContext2D, parts: { t: string; color: string }[], c: { font: string; size: number; outline: number; outlineColor: string; box: boolean; boxColor: string }, cx: number, y: number, anchor: "middle" | "top", scale = 1, margin = 40) {
  ctx.save();
  ctx.font = `bold ${c.size}px "${c.font}", "DejaVu Sans", Arial, sans-serif`;
  ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const lines = wrap(ctx, parts.map(p => p.t), W - 2 * margin), lh = c.size * 1.18, space = ctx.measureText(" ").width;
  const top = anchor === "middle" ? y - (lines.length * lh) / 2 : y;
  ctx.translate(cx, top + (lines.length * lh) / 2); ctx.scale(scale, scale); ctx.translate(-cx, -(top + (lines.length * lh) / 2));
  lines.forEach((line, li) => {
    const widths = line.map(i => ctx.measureText(parts[i].t).width), total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    const ly = top + li * lh + lh / 2;
    let x = cx - total / 2;
    if (c.box) { const pad = Math.max(8, Math.round(c.size * 0.22)); ctx.fillStyle = c.boxColor; ctx.fillRect(x - pad, ly - lh / 2 - pad / 2 + 4, total + pad * 2, lh + pad - 8); }
    line.forEach((i, k) => {
      if (!c.box && c.outline > 0) { ctx.lineWidth = c.outline * 2; ctx.strokeStyle = c.outlineColor; ctx.strokeText(parts[i].t, x, ly); }
      ctx.fillStyle = parts[i].color; ctx.textAlign = "left"; ctx.fillText(parts[i].t, x, ly);
      x += widths[k] + space;
    });
  });
  ctx.restore();
}

const pop = (since: number) => 0.82 + 0.18 * clamp(since / 0.11, 0, 1);

export default function ClipEditor({ clipId, onClose, onSaved }: { clipId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [bundle, setBundle] = useState<Bundle | null>(null), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const [edit, setEditState] = useState<Edit | null>(null), [past, setPast] = useState<Edit[]>([]), [future, setFuture] = useState<Edit[]>([]);
  const [tab, setTab] = useState<Tab>("captions"), [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [safe, setSafe] = useState(true), [saveStyle, setSaveStyle] = useState(false), [selected, setSelected] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), strip = useRef<HTMLDivElement>(null);
  const lastPush = useRef({ at: 0, key: "" }), editRef = useRef<Edit | null>(null);
  // The post caption is saved on its own (no re-render needed).
  const [postText, setPostText] = useState(""), [captionSource, setCaptionSource] = useState<string | null>(null), [captionBusy, setCaptionBusy] = useState<"" | "write" | "save">(""), [captionNote, setCaptionNote] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/clips/" + clipId + "/edit").then(async r => { const body = await r.json() as Bundle & { error?: string }; if (!r.ok) throw new Error(body.error); return body; })
      .then(b => { if (!live) return; setBundle(b); setEditState(b.edit); setPostText(b.caption.text ?? ""); setCaptionSource(b.caption.source); setCaptionNote(b.caption.error ? "Last attempt failed: " + b.caption.error : ""); if (b.legacy) setTab("frame"); })
      .catch(e => live && setError(e instanceof Error ? e.message : "Couldn't open this clip."));
    return () => { live = false; };
  }, [clipId]);

  // Every change goes through here. Rapid changes to the same control (a slider drag) become one undo step.
  const change = useCallback((key: string, next: (e: Edit) => Edit) => {
    setEditState(current => {
      if (!current) return current;
      const now = Date.now();
      if (!(lastPush.current.key === key && now - lastPush.current.at < 600)) { setPast(p => [...p.slice(-49), current]); setFuture([]); }
      lastPush.current = { at: now, key };
      return next(current);
    });
  }, []);
  const undo = useCallback(() => { setPast(p => { if (!p.length || !editRef.current) return p; const prev = p[p.length - 1]; setFuture(f => [editRef.current!, ...f]); setEditState(prev); lastPush.current = { at: 0, key: "" }; return p.slice(0, -1); }); }, []);
  const redo = useCallback(() => { setFuture(f => { if (!f.length || !editRef.current) return f; setPast(p => [...p, editRef.current!]); setEditState(f[0]); lastPush.current = { at: 0, key: "" }; return f.slice(1); }); }, []);
  useEffect(() => { editRef.current = edit; }, [edit]);

  const words: Word[] = useMemo(() => edit?.words ?? bundle?.words ?? [], [edit?.words, bundle?.words]);
  const cueList = useMemo(() => edit ? cues(words, edit) : [], [words, edit]);
  const cueRef = useRef(cueList);
  useEffect(() => { cueRef.current = cueList; }, [cueList]);
  const duration = bundle?.source.duration ?? 0;

  // Draw loop: video frame, framing, look, captions, hook, progress bar. Loops playback inside the trim.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = video.current, cv = canvas.current, e = editRef.current;
      if (!v || !cv || !e || !bundle) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      if (v.currentTime >= e.trim.end - 0.03 || v.currentTime < e.trim.start - 0.25) { v.currentTime = e.trim.start; }
      const t = v.currentTime, rel = t - e.trim.start;
      setTime(prev => Math.abs(prev - t) > 0.05 ? t : prev);
      const sw = v.videoWidth || bundle.source.width, sh = v.videoHeight || bundle.source.height;
      const box = layout(e.frame, sw, sh), l = e.look;
      const look = `brightness(${l.brightness}) contrast(${l.contrast}) saturate(${l.saturation})`;
      ctx.save();
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
      if (v.readyState >= 2) {
        if (e.frame.mode === "blur") {
          const cover = Math.max(W / sw, H / sh), cw = sw * cover, ch = sh * cover;
          ctx.filter = look + " blur(26px) brightness(0.86)";
          ctx.drawImage(v, (W - cw) / 2 - 30, (H - ch) / 2 - 30, cw + 60, ch + 60);
        }
        ctx.filter = look;
        ctx.drawImage(v, box.x, box.y, box.w, box.h);
        ctx.filter = "none";
      }
      const c = e.captions, hit = c.on ? activeCue(cueRef.current, rel) : null;
      if (hit) {
        const { cue, word } = hit, w = cue.words[word];
        const y = c.y * H;
        if (c.animation === "word") drawText(ctx, [{ t: w.t, color: c.color }], c, W / 2, y, "middle", pop(rel - w.s));
        else drawText(ctx, cue.words.map((x: { t: string }, i: number) => ({ t: x.t, color: c.animation === "karaoke" && i === word ? c.highlight : c.color })), c, W / 2, y, "middle", c.animation === "pop" || c.animation === "karaoke" ? pop(rel - cue.start) : 1);
      }
      if (e.hook.text && rel < e.hook.seconds) drawText(ctx, [{ t: e.hook.text, color: e.hook.color }], { font: c.font, size: 52, outline: 0, outlineColor: "#000000", box: true, boxColor: e.hook.bg }, W / 2, 150, "top", pop(rel), 60);
      if (e.progress.on) { ctx.fillStyle = e.progress.color; ctx.fillRect(0, H - 10, W * clamp(rel / (e.trim.end - e.trim.start), 0, 1), 10); }
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bundle]);

  const toggle = useCallback(() => { const v = video.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }, []);
  const seek = useCallback((t: number) => { const v = video.current, e = editRef.current; if (v && e) v.currentTime = clamp(t, e.trim.start, e.trim.end - 0.05); }, []);
  const setTrim = useCallback((which: "start" | "end", t: number) => change("trim-" + which, e => {
    let { start, end } = e.trim;
    if (which === "start") start = clamp(t, Math.max(0, end - MAX_CLIP), end - MIN_CLIP); else end = clamp(t, start + MIN_CLIP, Math.min(duration, start + MAX_CLIP));
    return { ...e, trim: { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 } };
  }), [change, duration]);

  // Keyboard: space plays, I/O set the start/end at the playhead, ctrl+z / ctrl+shift+z undo and redo.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target.closest("input,textarea,select")) return;
      if (ev.key === " ") { ev.preventDefault(); toggle(); }
      else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (ev.key.toLowerCase() === "i" && video.current) setTrim("start", video.current.currentTime);
      else if (ev.key.toLowerCase() === "o" && video.current) setTrim("end", video.current.currentTime);
      else if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undo, redo, setTrim, onClose]);

  // Drag the picture to reposition it within the room the zoom leaves.
  const drag = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => { if (!edit) return; ev.currentTarget.setPointerCapture(ev.pointerId); drag.current = { x: ev.clientX, y: ev.clientY, fx: edit.frame.x, fy: edit.frame.y }; };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, cv = canvas.current, v = video.current;
    if (!d || !cv || !bundle) return;
    const scale = W / cv.getBoundingClientRect().width;
    const box = layout({ ...editRef.current!.frame, x: 0, y: 0 }, v?.videoWidth || bundle.source.width, v?.videoHeight || bundle.source.height);
    const roomX = Math.abs(W - box.w) / 2, roomY = Math.abs(H - box.h) / 2;
    change("pan", e => ({ ...e, frame: { ...e.frame, x: roomX ? clamp(d.fx + (ev.clientX - d.x) * scale / roomX, -1, 1) : 0, y: roomY ? clamp(d.fy + (ev.clientY - d.y) * scale / roomY, -1, 1) : 0 } }));
  };

  // Timeline: drag the trim handles or click to seek.
  const timeAt = (clientX: number) => { const r = strip.current!.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * duration; };
  const dragHandle = (ev: React.PointerEvent<HTMLElement>) => {
    const which = ev.currentTarget.dataset.which as "start" | "end";
    ev.stopPropagation(); ev.currentTarget.setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => { setTrim(which, timeAt(m.clientX)); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const captionAction = async (body: { action: "write" } | { action: "save"; text: string }) => {
    setCaptionBusy(body.action); setCaptionNote(""); setError("");
    try {
      const response = await fetch("/api/clips/" + clipId + "/caption", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string; text: string | null; source: string | null; message: string };
      if (!response.ok) throw new Error(result.error);
      setPostText(result.text ?? ""); setCaptionSource(result.source); setCaptionNote(result.message);
    } catch (e) { setCaptionNote(e instanceof Error ? e.message : "Couldn't update the caption."); }
    finally { setCaptionBusy(""); }
  };

  const save = async () => {
    if (!edit || !bundle) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/clips/" + clipId + "/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edit, rev: bundle.rev, ...(saveStyle && { saveStyle: "streamer" }) }) });
      const result = await response.json() as { error?: string; message: string };
      if (!response.ok) throw new Error(result.error);
      onSaved(result.message);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the edit."); }
    finally { setSaving(false); }
  };

  if (!bundle || !edit) return <div className="editor-shell"><div className="editor-loading">{error ? <><p className="error" role="alert">{error}</p><button className="secondary" onClick={onClose}><ArrowLeft size={16} />Back to clips</button></> : <><Loader2 className="spin" size={22} />Opening the editor…</>}</div></div>;

  const c = edit.captions, len = edit.trim.end - edit.trim.start;
  const set = <K extends keyof Edit>(key: K, value: Partial<Edit[K]>) => change(String(key) + Object.keys(value).join(), e => ({ ...e, [key]: { ...(e[key] as object), ...value } }));
  const setCaption = (value: Partial<Captions>) => change("captions" + Object.keys(value).join(), e => ({ ...e, captions: { ...e.captions, ...value, preset: "preset" in value ? value.preset! : "custom" } }));
  const maxChat = Math.max(1, ...(bundle.signals?.chat ?? [0]));
  const pct = (t: number) => (t / duration) * 100;
  const editWord = (i: number, text: string) => change("word" + i, e => { const list = [...(e.words ?? bundle.words)].map(w => [...w] as Word); list[i][2] = text.replace(/[{}\\\r\n]/g, "").slice(0, 40); return { ...e, words: list }; });

  return <div className="editor-shell" role="dialog" aria-label="Clip editor">
    <header className="editor-top">
      <button className="secondary" onClick={onClose}><ArrowLeft size={16} />Clips</button>
      <div className="editor-title"><strong>{bundle.streamer ?? "Clip"}</strong><small>{new Date(bundle.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {len.toFixed(1)}s{bundle.render.state === "queued" ? " · rendering a saved edit" : bundle.render.state === "failed" ? " · last render failed" : ""}</small></div>
      <div className="editor-actions">
        <button className="icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
        <button className="icon-button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button>
        <button className="icon-button" aria-label="Discard changes" title="Discard changes" disabled={!past.length} onClick={() => { setPast(p => [...p, edit]); setEditState(bundle.edit); }}><RotateCcw size={16} /></button>
        <label className="editor-check" title={"New clips from " + (bundle.streamer ?? "this streamer") + " start with this framing, look and caption style"}><input type="checkbox" checked={saveStyle} onChange={e => setSaveStyle(e.target.checked)} />Use this look for {bundle.streamer ?? "this streamer"}&apos;s new clips</label>
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}Save &amp; render</button>
      </div>
    </header>
    {error && <div className="error editor-error" role="alert">{error}</div>}
    {bundle.render.state === "failed" && bundle.render.error && <div className="error editor-error" role="status">The last render failed: {bundle.render.error}. Saving again retries it.</div>}
    {!bundle.sourceStored && <div className="notice editor-error"><p>The editable source isn&apos;t in clip storage yet, so the preview can&apos;t play. The worker still re-renders your edits while it keeps this clip.</p></div>}
    <div className="editor-body">
      <section className="editor-stage">
        <div className="phone">
          <canvas ref={canvas} width={W} height={H} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} title="Drag to reposition the picture" />
          {safe && <div className="safe-zones" aria-hidden><span className="sz-top" /><span className="sz-right">App buttons</span><span className="sz-bottom">Username &amp; caption</span></div>}
        </div>
        <video ref={video} className="editor-video" src={bundle.sourceStored ? "/api/clips/" + clipId + "/source" : undefined} playsInline preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => { e.currentTarget.currentTime = edit.trim.start; }} />
        <div className="stage-controls">
          <button className="icon-button play" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
          <span className="timecode">{fmt(Math.max(0, time - edit.trim.start))} / {fmt(len)}</span>
          <button className="text-button" onClick={() => setSafe(s => !s)} title="Show where TikTok, Reels and Shorts draw their buttons">{safe ? <EyeOff size={14} /> : <Eye size={14} />}{safe ? "Hide" : "Show"} safe zones</button>
        </div>
      </section>
      <section className="editor-panel">
        <div className="editor-timeline">
          <div className="timeline-head"><span><Scissors size={14} /> Trim · {fmt(edit.trim.start)} to {fmt(edit.trim.end)}</span><span className="muted">Drag the handles, or press I and O at the playhead</span></div>
          <div className="heat" ref={strip} onPointerDown={ev => seek(timeAt(ev.clientX))}>
            <div className="heat-bars" aria-hidden>{Array.from({ length: Math.max(1, Math.ceil(duration)) }, (_, i) => { const e = bundle.signals?.energy[i] ?? 0, ch = (bundle.signals?.chat[i] ?? 0) / maxChat; return <span key={i} style={{ height: Math.max(6, e * 100) + "%", background: ch > 0.05 ? `color-mix(in srgb, #ff7a59 ${Math.round(ch * 100)}%, #4b5a6b)` : undefined }} />; })}</div>
            <div className="heat-shade" style={{ left: 0, width: pct(edit.trim.start) + "%" }} />
            <div className="heat-shade" style={{ left: pct(edit.trim.end) + "%", right: 0 }} />
            <div className="heat-range" style={{ left: pct(edit.trim.start) + "%", width: pct(len) + "%" }}>
              <span className="handle start" role="slider" aria-label="Clip start" aria-valuenow={edit.trim.start} tabIndex={0} data-which="start" onPointerDown={dragHandle} onKeyDown={ev => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") setTrim("start", edit.trim.start + (ev.key === "ArrowLeft" ? -0.25 : 0.25)); }} />
              <span className="handle end" role="slider" aria-label="Clip end" aria-valuenow={edit.trim.end} tabIndex={0} data-which="end" onPointerDown={dragHandle} onKeyDown={ev => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") setTrim("end", edit.trim.end + (ev.key === "ArrowLeft" ? -0.25 : 0.25)); }} />
            </div>
            <div className="playhead" style={{ left: pct(time) + "%" }} />
          </div>
          {bundle.signals && <div className="heat-legend"><span><i className="loud" />Loudness</span><span><i className="chat" />Chat activity</span><span className="muted">Why this moment was clipped</span></div>}
        </div>
        <div className="editor-tabs" role="tablist">{(["captions", "frame", "extras", "transcript", "post"] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{{ captions: "Captions", frame: "Frame & look", extras: "Hook & extras", transcript: "Transcript", post: "Post caption" }[t]}</button>)}</div>
        <div className="editor-controls">
          {bundle.legacy && (tab === "captions" || tab === "transcript") && <div className="subtle-note">This clip was captured before the editor existed, so its captions are part of the picture and can&apos;t be restyled or corrected. You can still trim it, reframe it, adjust its colour, and add a hook title and progress bar. Clips captured from now on are fully editable.</div>}
          {tab === "post" && <>
            <p className="hint">The text posted with this clip on Instagram, TikTok and YouTube. The first line is also the YouTube title. {bundle.caption.ai ? "Created locally from the saved transcript with streamer credit and keyword hashtags. Save transcript or trim changes before generating." : "Automatic transcript captions are disabled in Settings. You can still generate one or type your own."}</p>
            <label className="wide">Caption <small>{captionSource === "local" ? "Created from transcript" : captionSource === "ai" ? "Previously AI-generated" : captionSource === "edited" ? "Your text: never automatically replaced" : "Not written yet: " + (bundle.caption.ai ? "created from the transcript before posting" : "the template is used")}</small>
              <textarea rows={9} maxLength={2200} value={postText} onChange={e => setPostText(e.target.value)} placeholder={bundle.caption.ai ? "Leave empty to use an automatic caption or fallback" : "Type the caption to post with this clip"} /></label>
            <div className="caption-actions"><span className="muted">{postText.length} / 2200</span>
              <button className="secondary" disabled={!!captionBusy} title="Uses the saved transcript; replaces the current caption" onClick={() => void captionAction({ action: "write" })}>{captionBusy === "write" ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}{postText ? "Generate from transcript" : "Generate from transcript"}</button>
              <button className="primary" disabled={!!captionBusy} onClick={() => void captionAction({ action: "save", text: postText })}>{captionBusy === "save" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}Save caption</button></div>
            {captionNote && <p className="hint" role="status">{captionNote}</p>}
          </>}
          {tab === "captions" && !bundle.legacy && <>
            <label className="switch-row"><input type="checkbox" checked={c.on} onChange={e => setCaption({ on: e.target.checked, preset: c.preset })} />Show captions</label>
            <div className="presets">{Object.entries(PRESETS).map(([key, p]) => <button key={key} className={c.preset === key ? "preset active" : "preset"} onClick={() => { const { label: _label, ...values } = p as typeof p & { label: string }; void _label; setCaption({ ...values, preset: key }); }} style={{ fontFamily: `"${p.font}", sans-serif`, color: p.box ? p.color : p.color, background: p.box ? p.boxColor : undefined, textShadow: p.box ? "none" : `0 0 3px ${p.outlineColor}, 0 0 3px ${p.outlineColor}` }}>{p.uppercase ? p.label.toUpperCase() : p.label}</button>)}</div>
            <div className="control-grid">
              <label>Font<select value={c.font} onChange={e => setCaption({ font: e.target.value })}>{FONTS.map((f: string) => <option key={f} style={{ fontFamily: f }}>{f}</option>)}</select></label>
              <label>Animation<select value={c.animation} onChange={e => setCaption({ animation: e.target.value })}>{ANIMATIONS.map((a: string) => <option key={a} value={a}>{animationLabels[a]}</option>)}</select></label>
              <label>Size <span>{c.size}</span><input type="range" min={24} max={140} value={c.size} onChange={e => setCaption({ size: Number(e.target.value) })} /></label>
              <label>Words per line <span>{c.words}</span><input type="range" min={1} max={8} value={c.words} onChange={e => setCaption({ words: Number(e.target.value) })} /></label>
              <label>Position <span>{Math.round(c.y * 100)}% down</span><input type="range" min={8} max={95} value={Math.round(c.y * 100)} onChange={e => setCaption({ y: Number(e.target.value) / 100 })} /></label>
              <label>Outline <span>{c.outline}px</span><input type="range" min={0} max={12} value={c.outline} disabled={c.box} onChange={e => setCaption({ outline: Number(e.target.value) })} /></label>
              <label className="color">Text<input type="color" value={c.color} onChange={e => setCaption({ color: e.target.value })} /></label>
              <label className="color">Highlight<input type="color" value={c.highlight} onChange={e => setCaption({ highlight: e.target.value })} /></label>
              <label className="color">Outline<input type="color" value={c.outlineColor} onChange={e => setCaption({ outlineColor: e.target.value })} /></label>
              <label className="color">Box<input type="color" value={c.boxColor} onChange={e => setCaption({ boxColor: e.target.value })} /></label>
            </div>
            <div className="toggles">
              <label><input type="checkbox" checked={c.box} onChange={e => setCaption({ box: e.target.checked })} />Background box</label>
              <label><input type="checkbox" checked={c.uppercase} onChange={e => setCaption({ uppercase: e.target.checked })} />ALL CAPS</label>
              <label title="Replaces swear words with asterisks, e.g. f***, which keeps clips safer for brand-friendly accounts"><input type="checkbox" checked={c.mask} onChange={e => setCaption({ mask: e.target.checked })} />Bleep swear words in captions</label>
            </div>
          </>}
          {tab === "frame" && <>
            <div className="segmented">{(["blur", "crop", "fit"] as const).map(m => <button key={m} className={edit.frame.mode === m ? "active" : ""} onClick={() => set("frame", { mode: m })}>{{ blur: "Blurred fill", crop: "Fill (crop)", fit: "Fit with bars" }[m]}</button>)}</div>
            <div className="control-grid">
              <label>Zoom <span>{edit.frame.zoom.toFixed(2)}×</span><input type="range" min={1} max={3} step={0.01} value={edit.frame.zoom} onChange={e => set("frame", { zoom: Number(e.target.value) })} /></label>
              <label>Left / right <span>{Math.round(edit.frame.x * 100)}</span><input type="range" min={-1} max={1} step={0.01} value={edit.frame.x} onChange={e => set("frame", { x: Number(e.target.value) })} /></label>
              <label>Up / down <span>{Math.round(edit.frame.y * 100)}</span><input type="range" min={-1} max={1} step={0.01} value={edit.frame.y} onChange={e => set("frame", { y: Number(e.target.value) })} /></label>
              <label>Brightness <span>{Math.round(edit.look.brightness * 100)}%</span><input type="range" min={0.5} max={1.5} step={0.01} value={edit.look.brightness} onChange={e => set("look", { brightness: Number(e.target.value) })} /></label>
              <label>Contrast <span>{Math.round(edit.look.contrast * 100)}%</span><input type="range" min={0.5} max={1.5} step={0.01} value={edit.look.contrast} onChange={e => set("look", { contrast: Number(e.target.value) })} /></label>
              <label>Saturation <span>{Math.round(edit.look.saturation * 100)}%</span><input type="range" min={0} max={2} step={0.01} value={edit.look.saturation} onChange={e => set("look", { saturation: Number(e.target.value) })} /></label>
            </div>
            <p className="hint">Tip: drag the preview to move the picture. Zoom in on a facecam with “Fill (crop)” and drag it into place.</p>
            <button className="secondary" onClick={() => change("reset-frame", e => ({ ...e, frame: { ...e.frame, zoom: 1, x: 0, y: 0 }, look: { brightness: 1, contrast: 1, saturation: 1 } }))}>Reset framing and colour</button>
          </>}
          {tab === "extras" && <>
            <label className="wide">Hook title <small>Shown at the top for the first seconds, to stop the scroll</small><input maxLength={90} placeholder="e.g. He did NOT see that coming" value={edit.hook.text} onChange={e => set("hook", { text: e.target.value })} /></label>
            <div className="control-grid">
              <label>Hook length <span>{edit.hook.seconds}s</span><input type="range" min={1} max={10} step={0.5} value={edit.hook.seconds} onChange={e => set("hook", { seconds: Number(e.target.value) })} /></label>
              <label className="color">Hook text<input type="color" value={edit.hook.color} onChange={e => set("hook", { color: e.target.value })} /></label>
              <label className="color">Hook background<input type="color" value={edit.hook.bg} onChange={e => set("hook", { bg: e.target.value })} /></label>
            </div>
            <label className="switch-row"><input type="checkbox" checked={edit.progress.on} onChange={e => set("progress", { on: e.target.checked })} />Progress bar along the bottom <small>Viewers who can see the end coming watch to it</small></label>
            {edit.progress.on && <label className="color inline">Bar colour<input type="color" value={edit.progress.color} onChange={e => set("progress", { color: e.target.value })} /></label>}
          </>}
          {tab === "transcript" && !bundle.legacy && <>
            <p className="hint">Click a word to jump to it. Fix a mis-heard word by editing it; clear a word to hide it from the captions. Words outside the trim are dimmed.</p>
            {words.length ? <div className="transcript">{words.map((w, i) => {
              const inside = w[0] >= edit.trim.start - 0.05 && w[1] <= edit.trim.end + 0.05, now = time >= w[0] && time < w[1];
              return selected === i
                ? <input key={i} autoFocus className="word-input" defaultValue={w[2]} onBlur={e => { if (e.target.value !== w[2]) editWord(i, e.target.value); setSelected(null); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setSelected(null); }} />
                : <button key={i} className={"word" + (inside ? "" : " outside") + (now ? " now" : "") + (w[2] ? "" : " hidden")} onClick={() => { seek(w[0]); }} onDoubleClick={() => setSelected(i)} title="Click to jump, double-click to edit">{w[2] || "(hidden)"}</button>;
            })}</div> : <p className="muted">No speech was transcribed for this clip.</p>}
            {edit.words && <button className="secondary" onClick={() => change("words-reset", e => { const next = { ...e }; delete next.words; return next; })}>Restore the original transcript</button>}
          </>}
        </div>
      </section>
    </div>
  </div>;
}
