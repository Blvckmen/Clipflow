"use client";
// The preview: the clip drawn on a canvas the way the worker renders it, with the transport under it (play, time,
// loop, speed, sound, full screen, safe zones) and plain warnings about where the text sits.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Maximize2, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import { HOOK_FADE_MS, HOOK_OUTLINE, HOOK_X, HOOK_Y, MULTI, activeCue, hookLines, multiAreas, multiPlacements, camAreas, canvas as frameSize, facecamPlacement, hookLook, hookOutlineColor, hookPlacement, layout, splitAreas, stacks, zoomAt } from "../../worker/edit.mjs";
import { drawCam, drawChat, drawGameUi, drawMulti, drawText, pop } from "./draw";
import { layoutWarnings } from "./warnings.mjs";
import { clamp, fmt, setMedia, type Box, type Bundle, type Change, type ClipTimeline, type Edit, type Frame } from "./types";

type Cue = { start: number; end: number; words: { t: string; s: number; k?: boolean }[] };
type ChatWindow = { start: number; end: number; lines: { name: string; text: string; color: string }[] };
type Timeline = ClipTimeline;
// The phone apps' own buttons, in canvas pixels (the safe-zone overlay): top bar, right-hand buttons, bottom text.
const SAFE = { top: 120, right: 110, bottom: 300 };
const SPEEDS = [0.5, 1, 1.5, 2];

// The opening title: each line (hookLines: its own colour and size when it has one) under the one before, popping in,
// fading in and out (HOOK_FADE_MS at each end of hook.seconds) or still, as hook.anim says. While it's being placed it
// shows plainly. Returns the box around all its lines.
function drawHook(ctx: CanvasRenderingContext2D, e: Edit, out: number, placing: boolean): Box {
  const hp = hookPlacement(e), hl = hookLook(e), anim = e.hook.anim ?? "pop", fade = HOOK_FADE_MS / 1000;
  const look = { font: hl.font, bold: hl.bold, italic: hl.italic, shadow: hl.shadow, align: hl.align };
  ctx.save();
  if (!placing && anim === "fade") ctx.globalAlpha = clamp(Math.min(out / fade, (e.hook.seconds - out) / fade), 0, 1);
  const scale = placing || anim !== "pop" ? 1 : pop(out);
  let y = hp.y, box: Box | null = null;
  for (const line of hookLines(e) as { text: string; color: string; size: number }[]) {
    const c = e.hook.bg ? { ...look, size: line.size, outline: 0, outlineColor: "#000000", box: true, boxColor: e.hook.bg } : { ...look, size: line.size, outline: Math.max(3, Math.round(line.size * HOOK_OUTLINE / 52)), outlineColor: hookOutlineColor(line.color), box: false, boxColor: "#000000" };
    const b = drawText(ctx, line.text.split(" ").filter(Boolean).map(t => ({ t, color: line.color })), c, hp.x, y, "top", scale, 60, hp.wrap);
    box = box ? { left: Math.min(box.left, b.left), right: Math.max(box.right, b.right), top: box.top, bottom: b.bottom } : b;
    y = b.bottom;
  }
  ctx.restore();
  return box ?? { left: hp.x, right: hp.x, top: hp.y, bottom: hp.y };
}

export function Stage({ bundle, edit, editRef, change, video, cues, chat, tl, placing, bgPreview, bgIsImage, hasBackgrounds, onTime }: {
  bundle: Bundle; edit: Edit; editRef: RefObject<Edit | null>; change: Change; video: RefObject<HTMLVideoElement | null>;
  cues: Cue[]; chat: ChatWindow[]; tl: Timeline | null; placing: boolean; bgPreview: string | null; bgIsImage: boolean; hasBackgrounds: boolean; onTime: (t: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), phone = useRef<HTMLDivElement>(null), bgImage = useRef<HTMLImageElement>(null), bgVideo = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [safe, setSafe] = useState(true), [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1), [muted, setMuted] = useState(false), [warnings, setWarnings] = useState<string[]>([]);
  // What the draw loop reads (it runs outside React's render).
  const live = useRef({ cues, chat, tl, placing, loop, hasBackgrounds });
  useEffect(() => { live.current = { cues, chat, tl, placing, loop, hasBackgrounds }; }, [cues, chat, tl, placing, loop, hasBackgrounds]);
  const hookBox = useRef<Box | null>(null), boxes = useRef<{ hook: Box | null; captions: Box | null; key: string }>({ hook: null, captions: null, key: "" });

  // Draw loop: video frame, framing, look, captions, hook, progress bar. Loops playback inside the trim (or stops at
  // its end with loop off).
  useEffect(() => {
    let raf = 0, last = { e: null as Edit | null, t: -1, placing: false, at: 0 };
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = video.current, cv = canvas.current, e = editRef.current, L = live.current;
      if (!v || !cv || !e) return;
      // Paused and nothing changed: skip the frame, still redrawing a few times a second for images and fonts that
      // finish loading.
      const now = performance.now();
      if (v.paused && e === last.e && v.currentTime === last.t && L.placing === last.placing && now - last.at < 250) return;
      last = { e, t: v.currentTime, placing: L.placing, at: now };
      const { W, H } = frameSize(e.frame);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      if (v.currentTime >= e.trim.end - 0.03) { if (L.loop || v.paused) v.currentTime = e.trim.start; else { v.pause(); v.currentTime = e.trim.end - 0.05; } }
      else if (v.currentTime < e.trim.start - 0.25) v.currentTime = e.trim.start;
      const tr = L.tl, gap = !v.paused && tr?.cuts.find(([a, b]) => v.currentTime - e.trim.start >= a && v.currentTime - e.trim.start < b - 0.02);
      if (gap) v.currentTime = e.trim.start + gap[1];
      const t = v.currentTime, rel = t - e.trim.start, out = tr ? tr.toClip(rel) : rel, clipLen = tr?.length ?? e.trim.end - e.trim.start;
      const zoom = tr?.punches.length ? zoomAt(tr.punches, out) : 1;
      setTime(prev => Math.abs(prev - t) > 0.05 ? t : prev);
      const sw = v.videoWidth || bundle.source.width, sh = v.videoHeight || bundle.source.height;
      // A multi-webcam layout without a box for each person shows the blurred fill, like the render.
      const pf: Frame = (MULTI as Record<string, number>)[e.frame.mode] && !multiPlacements(e.frame, sw, sh) ? { ...e.frame, mode: "blur" } : e.frame;
      const box = layout(pf, sw, sh), l = e.look;
      const look = `brightness(${l.brightness}) contrast(${l.contrast}) saturate(${l.saturation})`;
      ctx.save();
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
      // A punch-in zooms the whole picture on its middle (captions stay put).
      ctx.save();
      if (zoom !== 1) { ctx.translate(W / 2, H / 2); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2); }
      if (v.readyState >= 2 && e.frame.mode === "split") {
        // The stream in its part (cut off at the seam), the background in the other, in the chosen order.
        const areas = splitAreas(e.frame), sb = areas.background, divider = e.frame.split?.divider;
        ctx.save(); ctx.beginPath(); ctx.rect(0, areas.stream.y, W, areas.stream.h); ctx.clip();
        ctx.filter = look; ctx.drawImage(v, box.x, box.y + areas.stream.y, box.w, box.h); ctx.filter = "none"; ctx.restore();
        // A still image, or a looping video kept in step with the clip's play/pause.
        const img = bgImage.current, bg = bgVideo.current;
        const ready = img ? img.complete && img.naturalWidth > 0 : !!bg && bg.readyState >= 2;
        if (ready) {
          if (bg && v.paused !== bg.paused) { if (v.paused) bg.pause(); else void bg.play().catch(() => {}); }
          // The background's sound at its chosen volume (muted at 0, the default).
          if (bg) { const vol = e.frame.split?.volume ?? 0; bg.muted = vol <= 0 || v.muted; bg.volume = clamp(vol, 0, 1); }
          const source = (img ?? bg)!, bw = img ? img.naturalWidth : bg!.videoWidth, bh = img ? img.naturalHeight : bg!.videoHeight, cover = Math.max(W / bw, sb.h / bh);
          ctx.save(); ctx.beginPath(); ctx.rect(0, sb.y, W, sb.h); ctx.clip();
          ctx.drawImage(source, (W - bw * cover) / 2, sb.y + (sb.h - bh * cover) / 2, bw * cover, bh * cover); ctx.restore();
        } else {
          ctx.fillStyle = "#1b2128"; ctx.fillRect(0, sb.y, W, sb.h);
          ctx.fillStyle = "#8b97a6"; ctx.font = "28px Arial, sans-serif"; ctx.textAlign = "center";
          ctx.fillText(L.hasBackgrounds ? "Background loading…" : "Upload backgrounds in Settings", W / 2, sb.y + sb.h / 2);
        }
        if (divider) { ctx.fillStyle = divider; ctx.fillRect(0, areas.seam - 3, W, 6); }
      } else if (v.readyState >= 2 && pf.mode === "gameui") {
        ctx.filter = look; drawGameUi(ctx, v, pf, sw, sh, box); ctx.filter = "none";
      } else if (v.readyState >= 2 && multiAreas(pf)) {
        ctx.filter = look; drawMulti(ctx, v, pf, sw, sh, box); ctx.filter = "none";
      } else if (v.readyState >= 2 && (e.frame.mode === "cam" || e.frame.mode === "pip") && e.frame.facecam?.box) {
        // Facecam layouts: the game (the stream, cut to its part) and the webcam cut out of the same stream.
        const fp = facecamPlacement(e.frame, sw, sh)!, game = e.frame.mode === "cam" ? camAreas(e.frame).game : { y: 0, h: H };
        ctx.filter = look;
        ctx.save(); ctx.beginPath(); ctx.rect(0, game.y, W, game.h); ctx.clip(); ctx.drawImage(v, box.x, box.y + game.y, box.w, box.h); ctx.restore();
        drawCam(ctx, v, e.frame, fp);
        ctx.filter = "none";
        const divider = e.frame.split?.divider;
        if (e.frame.mode === "cam" && divider) { ctx.fillStyle = divider; ctx.fillRect(0, camAreas(e.frame).seam - 3, W, 6); }
      } else if (v.readyState >= 2) {
        if (pf.mode === "blur") {
          const cover = Math.max(W / sw, H / sh), cw = sw * cover, ch = sh * cover;
          ctx.filter = look + " blur(26px) brightness(0.86)";
          ctx.drawImage(v, (W - cw) / 2 - 30, (H - ch) / 2 - 30, cw + 60, ch + 60);
        }
        ctx.filter = look;
        ctx.drawImage(v, box.src.x, box.src.y, box.src.w, box.src.h, box.x, box.y, box.w, box.h);
        ctx.filter = "none";
      }
      ctx.restore();
      // Chat on the clip: the same windows as the render's (chatWindows), bottom-left, under the captions and hook.
      const chatNow = e.chat?.on ? L.chat.find(w => t >= w.start && t < w.end) : null;
      if (chatNow) drawChat(ctx, chatNow.lines, 40, e.chat!.y * H);
      const c = e.captions, hit = c.on ? activeCue(L.cues, rel) : null;
      let capBox: Box | null = null;
      if (hit) {
        const { cue, word } = hit, w = cue.words[word];
        const y = c.y * H;
        // A keyword (w.k) stands out in the keyword colour, or the highlight while it's spoken, and bigger.
        if (c.animation === "word") capBox = drawText(ctx, [{ t: w.t, color: w.k ? c.keywordColor : c.color, big: w.k }], c, W / 2, y, "middle", pop(rel - w.s));
        else capBox = drawText(ctx, cue.words.map((x: { t: string; k?: boolean }, i: number) => ({ t: x.t, big: x.k, color: c.animation === "karaoke" && i === word ? c.highlight : x.k ? c.keywordColor : c.color })), c, W / 2, y, "middle", c.animation === "pop" || c.animation === "karaoke" ? pop(rel - cue.start) : 1);
      }
      // Word by word (wrapped like the render), with the hook's own line breaks. While placing it (paused, on the
      // title panel) it shows even after its time.
      const hp = hookPlacement(e), placing = v.paused && L.placing;
      hookBox.current = e.hook.text && e.hook.on !== false && (out < e.hook.seconds || placing) ? drawHook(ctx, e, out, placing) : null;
      if (hookBox.current && placing) { const b = hookBox.current; ctx.save(); ctx.setLineDash([10, 8]); ctx.lineWidth = 3; ctx.strokeStyle = "#bcfa76"; ctx.strokeRect(b.left - 16, b.top - 8, b.right - b.left + 32, b.bottom - b.top + 16); ctx.restore(); }
      if (e.progress.on) { ctx.fillStyle = e.progress.color; ctx.fillRect(0, H - 10, W * clamp(out / clipLen, 0, 1), 10); }
      ctx.restore();
      // Warnings: from the last place each text was drawn, kept while it's off screen between lines; dropped when the
      // text is turned off or its look changes.
      const key = JSON.stringify([e.frame.aspect, c.on, c.y, c.size, c.words, c.align, e.hook.text, e.hook.on, e.hook.x, e.hook.y, e.hook.size, e.hook.align]);
      const B = boxes.current;
      if (B.key !== key) { B.key = key; B.hook = null; B.captions = null; }
      if (capBox) B.captions = capBox;
      if (hookBox.current) B.hook = hookBox.current;
      const next = layoutWarnings({ W, H }, { hook: e.hook.on !== false && e.hook.text ? B.hook : null, captions: c.on ? B.captions : null }, SAFE);
      setWarnings(prev => prev.join("|") === next.join("|") ? prev : next);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bundle, editRef, video]);

  useEffect(() => { onTime(time); }, [time, onTime]);
  useEffect(() => { setMedia(video.current, { playbackRate: speed }); }, [speed, video]);
  useEffect(() => { setMedia(video.current, { muted }); }, [muted, video]);
  const toggle = useCallback(() => { const v = video.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }, [video]);

  // Drag the hook to place it, or anywhere else to reposition the picture within the room the zoom leaves.
  const drag = useRef<{ x: number; y: number; fx: number; fy: number; hook?: boolean } | null>(null);
  const onHook = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const b = hookBox.current, cv = canvas.current;
    if (!b || !cv) return false;
    const r = cv.getBoundingClientRect(), s = frameSize(edit.frame).W / r.width, x = (ev.clientX - r.left) * s, y = (ev.clientY - r.top) * s;
    return x >= b.left - 24 && x <= b.right + 24 && y >= b.top - 16 && y <= b.bottom + 16;
  };
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    drag.current = onHook(ev) ? { x: ev.clientX, y: ev.clientY, fx: edit.hook.x, fy: edit.hook.y, hook: true } : { x: ev.clientX, y: ev.clientY, fx: edit.frame.x, fy: edit.frame.y };
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, cv = canvas.current, v = video.current;
    if (!d) { ev.currentTarget.style.cursor = onHook(ev) ? "move" : ""; return; }
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    if (d.hook) {
      const round = (n: number) => Math.round(n * 1000) / 1000;
      change("hook-move", e => ({ ...e, hook: { ...e.hook, x: round(clamp(d.fx + (ev.clientX - d.x) / r.width, HOOK_X[0], HOOK_X[1])), y: round(clamp(d.fy + (ev.clientY - d.y) / r.height, HOOK_Y[0], HOOK_Y[1])) } }));
      return;
    }
    const scale = frameSize(edit.frame).W / r.width;
    const box = layout({ ...edit.frame, x: 0, y: 0 }, v?.videoWidth || bundle.source.width, v?.videoHeight || bundle.source.height);
    const roomX = Math.abs(box.area.w - box.w) / 2, roomY = Math.abs(box.area.h - box.h) / 2;
    change("pan", e => ({ ...e, frame: { ...e.frame, x: roomX ? clamp(d.fx + (ev.clientX - d.x) * scale / roomX, -1, 1) : 0, y: roomY ? clamp(d.fy + (ev.clientY - d.y) * scale / roomY, -1, 1) : 0 } }));
  };

  const { W, H } = frameSize(edit.frame), finished = tl?.length ?? edit.trim.end - edit.trim.start;
  return <section className="editor-stage">
    <div ref={phone} className={"phone" + (stacks(edit.frame) ? "" : " landscape")} style={{ aspectRatio: W + " / " + H }}>
      <canvas ref={canvas} width={W} height={H} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onDoubleClick={toggle} title="Drag to move the picture, or the opening title" />
      {safe && <div className="safe-zones" aria-hidden><span className="sz-top" /><span className="sz-right">App buttons</span><span className="sz-bottom">Username &amp; post text</span></div>}
    </div>
    {warnings.length > 0 && <div className="stage-warnings" role="status">{warnings.map(w => <span key={w}><AlertTriangle size={13} />{w}</span>)}</div>}
    {edit.frame.mode === "split" && bgPreview && bgIsImage && <img ref={bgImage} key={bgPreview} src={"/api/backgrounds/" + bgPreview + "/file"} alt="" hidden />}
    {edit.frame.mode === "split" && bgPreview && !bgIsImage && <video ref={bgVideo} className="editor-video" key={bgPreview} src={bgPreview.startsWith("clip:") ? "/api/clips/" + bgPreview.slice(5) + "/source" : "/api/backgrounds/" + bgPreview + "/file"} muted loop playsInline preload="auto" />}
    <video ref={video} className="editor-video" src={bundle.sourceStored ? "/api/clips/" + bundle.id + "/source" : undefined} playsInline preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => { e.currentTarget.currentTime = edit.trim.start; e.currentTarget.playbackRate = speed; }} />
    <div className="stage-controls">
      <button className="icon-button play" aria-label={playing ? "Pause" : "Play"} title="Play / pause (space)" onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      <span className="timecode">{fmt(Math.max(0, tl ? tl.toClip(time - edit.trim.start) : time - edit.trim.start))} / {fmt(finished)}</span>
      <span className="stage-tools">
        <button className={"icon-button" + (loop ? " on" : "")} aria-pressed={loop} aria-label="Loop" title={loop ? "Looping" : "Stops at the end"} onClick={() => setLoop(x => !x)}><Repeat size={15} /></button>
        <select aria-label="Speed" title="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select>
        <button className="icon-button" aria-label={muted ? "Sound on" : "Mute"} title={muted ? "Sound on" : "Mute"} onClick={() => setMuted(m => !m)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
        <button className="icon-button" aria-label="Full screen" title="Full screen" onClick={() => void phone.current?.requestFullscreen?.()}><Maximize2 size={15} /></button>
        <button className={"icon-button" + (safe ? " on" : "")} aria-pressed={safe} aria-label="Safe zones" title="Where TikTok, Reels and Shorts draw their buttons" onClick={() => setSafe(s => !s)}>{safe ? <Eye size={15} /> : <EyeOff size={15} />}</button>
      </span>
    </div>
  </section>;
}
