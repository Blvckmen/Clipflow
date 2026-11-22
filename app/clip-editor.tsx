"use client";
// The clip editor. The preview is drawn on a canvas from the same layout and caption code (worker/edit.mjs) the
// worker renders with, so what you see is what gets posted. Saving stores the edit; the worker re-renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Eye, EyeOff, Loader2, Pause, Play, Redo2, RotateCcw, Scissors, Sparkles, Undo2, Copy } from "lucide-react";
import { ANIMATIONS, ASPECTS, ASPECT_LABELS, KEYWORD_SCALE, CHAT_SIZE, DEFAULT_CHAT, chatWindows, DEFAULT_FACECAM, DEFAULT_SPLIT, FONTS, HOOK_LINES, HOOK_OUTLINE, HOOK_DEFAULT, HOOK_SIZE, HOOK_X, HOOK_Y, hookOutlineColor, hookPlacement, MAX_CLIP, MIN_CLIP, PRESETS, activeCue, camAreas, canvas as frameSize, cues, facecamPlacement, layout, splitAreas, stacks, timeline, zoomAt } from "../worker/edit.mjs";

import { applyAutomaticHook } from "../worker/hooks.mjs";

type Split = { share: number; top: "stream" | "background"; divider: string | null; volume: number };
type CamBox = { x: number; y: number; w: number; h: number };
type Facecam = { box: CamBox | null; share: number; corner: "tl" | "tr" | "bl" | "br"; size: number };
type Aspect = keyof typeof ASPECTS;
type Frame = { mode: "blur" | "crop" | "fit" | "split" | "cam" | "pip" | "phone"; aspect?: Aspect; content?: CamBox | null; zoom: number; x: number; y: number; background?: string | null; split?: Split; facecam?: Facecam };
type Captions = { on: boolean; preset: string; font: string; size: number; color: string; highlight: string; outline: number; outlineColor: string; box: boolean; boxColor: string; uppercase: boolean; animation: string; words: number; y: number; mask: boolean; keywords: boolean; keywordColor: string };
type Word = [number, number, string];
export type Edit = { v: number; trim: { start: number; end: number }; frame: Frame; look: { brightness: number; contrast: number; saturation: number }; captions: Captions; hook: { text: string; seconds: number; color: string; bg: string | null; x: number; y: number; size: number }; progress: { on: boolean; color: string }; pace?: Pace; chat?: ChatLook; audio?: { music: "keep" | "lower" | "voice" }; words?: Word[] };
type ChatLook = { on: boolean; y: number };
// [seconds into the source, name, text, colour]: the Twitch chat sent during the clip's source.
type ChatMessage = [number, string, string, string | null];
type Pace = { cuts: "off" | "gentle" | "tight"; zooms: boolean };
type Bundle = { id: string; streamerId: string; streamer: string | null; edit: Edit; rev: number; words: Word[]; signals: { energy: number[]; chat: number[]; messages?: ChatMessage[] } | null; source: { width: number; height: number; duration: number; face?: CamBox | null; content?: CamBox | null }; legacy: boolean; sourceStored: boolean; render: { state: string | null; error: string | null; at: string | null }; createdAt: string; caption: { text: string | null; source: string | null; error: string | null; ai: boolean } };
type Tab = "frame" | "captions" | "extras" | "transcript" | "post";

const animationLabels: Record<string, string> = { none: "Static", pop: "Pop in", karaoke: "Karaoke", word: "One word at a time" };
const fmt = (t: number) => Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0");
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// Breaks words into lines no wider than `max` with the current font (or `measure`, for words drawn bigger).
function wrap(ctx: CanvasRenderingContext2D, words: string[], max: number, measure = (w: string, _i: number) => ctx.measureText(w).width) {
  const lines: number[][] = [];
  let line: number[] = [], width = 0;
  const space = ctx.measureText(" ").width;
  words.forEach((w, i) => {
    // A line break typed in the hook starts a new line.
    if (w === "\n") { if (line.length) lines.push(line); line = []; width = 0; return; }
    const ww = measure(w, i);
    if (line.length && width + space + ww > max) { lines.push(line); line = []; width = 0; }
    width += (line.length ? space : 0) + ww; line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

// Chat lines (name in its colour, then the message) stacked upwards from `bottom`, left-aligned at `x`, like the
// render's Chat style: Arial bold CHAT_SIZE with a 3px black outline. Lines don't wrap (the render's \q2).
function drawChat(ctx: CanvasRenderingContext2D, lines: { name: string; text: string; color: string }[], x: number, bottom: number, _max: number) {
  ctx.save();
  ctx.font = `bold ${CHAT_SIZE}px Arial, "DejaVu Sans", sans-serif`;
  ctx.textBaseline = "bottom"; ctx.textAlign = "left"; ctx.lineJoin = "round"; ctx.lineWidth = 6; ctx.strokeStyle = "#000000";
  const lh = CHAT_SIZE * 1.2;
  lines.forEach((l, i) => {
    const y = bottom - (lines.length - 1 - i) * lh, name = l.name + ":", rest = " " + l.text;
    ctx.strokeText(name, x, y); ctx.fillStyle = l.color; ctx.fillText(name, x, y);
    const nx = x + ctx.measureText(name).width;
    ctx.strokeText(rest, nx, y); ctx.fillStyle = "#ffffff"; ctx.fillText(rest, nx, y);
  });
  ctx.restore();
}

// `margin` matches the subtitle style's left/right margins in buildAss (captions 40, hook 60), so lines wrap at
// the same width as in the render.
// A part with `big` (a caption keyword) is drawn KEYWORD_SCALE bigger, like its \fscx/\fscy in the render.
function drawText(ctx: CanvasRenderingContext2D, parts: { t: string; color: string; big?: boolean }[], c: { font: string; size: number; outline: number; outlineColor: string; box: boolean; boxColor: string }, cx: number, y: number, anchor: "middle" | "top", scale = 1, margin = 40, wrapWidth = cx * 2 - 2 * margin) {
  ctx.save();
  let left = Infinity, right = -Infinity;
  const font = (big?: boolean) => `bold ${big ? Math.round(c.size * KEYWORD_SCALE) : c.size}px "${c.font}", "DejaVu Sans", Arial, sans-serif`;
  ctx.font = font();
  ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const measure = (t: string, i: number) => { if (!parts[i]?.big) return ctx.measureText(t).width; ctx.font = font(true); const w = ctx.measureText(t).width; ctx.font = font(); return w; };
  const lines = wrap(ctx, parts.map(p => p.t), wrapWidth, measure), lh = c.size * 1.18, space = ctx.measureText(" ").width;
  const top = anchor === "middle" ? y - (lines.length * lh) / 2 : y;
  ctx.translate(cx, top + (lines.length * lh) / 2); ctx.scale(scale, scale); ctx.translate(-cx, -(top + (lines.length * lh) / 2));
  lines.forEach((line, li) => {
    const widths = line.map(i => measure(parts[i].t, i)), total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    const ly = top + li * lh + lh / 2;
    let x = cx - total / 2;
    left = Math.min(left, x); right = Math.max(right, x + total);
    if (c.box) { const pad = Math.max(8, Math.round(c.size * 0.22)); ctx.fillStyle = c.boxColor; ctx.fillRect(x - pad, ly - lh / 2 - pad / 2 + 4, total + pad * 2, lh + pad - 8); }
    line.forEach((i, k) => {
      ctx.font = font(parts[i].big);
      if (!c.box && c.outline > 0) { ctx.lineWidth = c.outline * 2; ctx.strokeStyle = c.outlineColor; ctx.strokeText(parts[i].t, x, ly); }
      ctx.fillStyle = parts[i].color; ctx.textAlign = "left"; ctx.fillText(parts[i].t, x, ly);
      ctx.font = font();
      x += widths[k] + space;
    });
  });
  ctx.restore();
  // Where the text landed (before the pop scale), for dragging it.
  return { left, right, top, bottom: top + lines.length * lh };
}

const pop = (since: number) => 0.82 + 0.18 * clamp(since / 0.11, 0, 1);

// `onCopied`: a copy of this clip was made (Make a copy); the workspace opens it.
export default function ClipEditor({ clipId, onClose, onSaved, onCopied }: { clipId: string; onClose: () => void; onSaved: (message: string) => void; onCopied?: (id: string, message: string) => void }) {
  const [bundle, setBundle] = useState<Bundle | null>(null), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const makeCopy = async () => {
    setCopying(true); setError("");
    try {
      const response = await fetch("/api/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "duplicateClip", id: clipId }) });
      const body = (await response.json().catch(() => ({}))) as { clipId?: string; message?: string; error?: string };
      if (!response.ok || !body.clipId) throw new Error(body.error || "Couldn't copy the clip. Please retry.");
      onCopied?.(body.clipId, body.message ?? "Copied the clip.");
    } catch (e) { setError((e as Error).message); } finally { setCopying(false); }
  };
  const [edit, setEditState] = useState<Edit | null>(null), [past, setPast] = useState<Edit[]>([]), [future, setFuture] = useState<Edit[]>([]);
  const [tab, setTab] = useState<Tab>("captions"), [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [safe, setSafe] = useState(true), [saveStyle, setSaveStyle] = useState(false), [selected, setSelected] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), strip = useRef<HTMLDivElement>(null);
  // Split screen: the workspace's background videos, and the one playing under the preview.
  // Library videos and the workspace's other clips (by their unframed source) that can play underneath, with lengths.
  type BgVideo = { id: string; name: string; duration?: number | null; content_type?: string };
  type BgClip = { id: string; streamer: string | null; duration: number; created_at: string };
  const bgImage = useRef<HTMLImageElement>(null), bgVideo = useRef<HTMLVideoElement>(null), [backgrounds, setBackgrounds] = useState<BgVideo[]>([]), [bgClips, setBgClips] = useState<BgClip[]>([]);
  useEffect(() => {
    fetch("/api/backgrounds?for=" + clipId).then(r => (r.ok ? r.json() : {}) as Promise<{ backgrounds?: BgVideo[]; clips?: BgClip[] }>).then(b => { setBackgrounds(b.backgrounds ?? []); setBgClips(b.clips ?? []); }).catch(() => {});
  }, [clipId]);
  const lastPush = useRef({ at: 0, key: "" }), editRef = useRef<Edit | null>(null);
  // The post caption is saved on its own (no re-render needed).
  const [hookNote, setHookNote] = useState("");
  const [postText, setPostText] = useState(""), [captionSource, setCaptionSource] = useState<string | null>(null), [captionBusy, setCaptionBusy] = useState<"" | "save">(""), [captionNote, setCaptionNote] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/clips/" + clipId + "/edit").then(async r => { const body = await r.json() as Bundle & { error?: string }; if (!r.ok) throw new Error(body.error); return body; })
      .then(b => { if (!live) return; setBundle(b); setEditState(b.edit && { ...b.edit, hook: { ...HOOK_DEFAULT, ...b.edit.hook } }); setPostText(b.caption.text ?? ""); setCaptionSource(b.caption.source); setCaptionNote(b.caption.error ? "Last attempt failed: " + b.caption.error : ""); if (b.legacy) setTab("frame"); })
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
  const energy = bundle?.signals?.energy ?? null;
  const tl = useMemo(() => edit ? timeline(edit, words, energy) : null, [edit, words, energy]);
  const cueRef = useRef(cueList), backgroundsRef = useRef(backgrounds), tlRef = useRef(tl);
  const messages = bundle?.signals?.messages ?? null;
  const chatList = useMemo(() => edit && messages ? chatWindows(messages, edit) : [], [messages, edit]);
  const chatRef = useRef(chatList);
  // The hook's last drawn box (canvas pixels, null when hidden) for dragging it; while paused on Extras it shows
  // even after its time so it can be placed.
  const hookBox = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null), tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { chatRef.current = chatList; }, [chatList]);
  useEffect(() => { tlRef.current = tl; }, [tl]);
  useEffect(() => { backgroundsRef.current = backgrounds; }, [backgrounds]);
  useEffect(() => { cueRef.current = cueList; }, [cueList]);
  const duration = bundle?.source.duration ?? 0;

  // Draw loop: video frame, framing, look, captions, hook, progress bar. Loops playback inside the trim.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = video.current, cv = canvas.current, e = editRef.current;
      if (!v || !cv || !e || !bundle) return;
      const { W, H } = frameSize(e.frame);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      if (v.currentTime >= e.trim.end - 0.03 || v.currentTime < e.trim.start - 0.25) { v.currentTime = e.trim.start; }
      const tr = tlRef.current, gap = !v.paused && tr?.cuts.find(([a, b]) => v.currentTime - e.trim.start >= a && v.currentTime - e.trim.start < b - 0.02);
      if (gap) v.currentTime = e.trim.start + gap[1];
      const t = v.currentTime, rel = t - e.trim.start, out = tr ? tr.toClip(rel) : rel, clipLen = tr?.length ?? e.trim.end - e.trim.start;
      const zoom = tr?.punches.length ? zoomAt(tr.punches, out) : 1;
      setTime(prev => Math.abs(prev - t) > 0.05 ? t : prev);
      const sw = v.videoWidth || bundle.source.width, sh = v.videoHeight || bundle.source.height;
      const box = layout(e.frame, sw, sh), l = e.look;
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
          if (bg) { const vol = e.frame.split?.volume ?? 0; bg.muted = vol <= 0; bg.volume = Math.min(1, Math.max(0, vol)); }
          const source = (img ?? bg)!, bw = img ? img.naturalWidth : bg!.videoWidth, bh = img ? img.naturalHeight : bg!.videoHeight, cover = Math.max(W / bw, sb.h / bh);
          ctx.save(); ctx.beginPath(); ctx.rect(0, sb.y, W, sb.h); ctx.clip();
          ctx.drawImage(source, (W - bw * cover) / 2, sb.y + (sb.h - bh * cover) / 2, bw * cover, bh * cover); ctx.restore();
        } else {
          ctx.fillStyle = "#1b2128"; ctx.fillRect(0, sb.y, W, sb.h);
          ctx.fillStyle = "#8b97a6"; ctx.font = "28px Arial, sans-serif"; ctx.textAlign = "center";
          ctx.fillText(backgroundsRef.current.length ? "Background loading…" : "Upload background videos or images in Settings", W / 2, sb.y + sb.h / 2);
        }
        if (divider) { ctx.fillStyle = divider; ctx.fillRect(0, areas.seam - 3, W, 6); }
      } else if (v.readyState >= 2 && (e.frame.mode === "cam" || e.frame.mode === "pip") && e.frame.facecam?.box) {
        // Facecam layouts: the game (the stream, cut to its part) and the webcam cut out of the same stream.
        const fp = facecamPlacement(e.frame, sw, sh)!, game = e.frame.mode === "cam" ? camAreas(e.frame).game : { y: 0, h: H };
        ctx.filter = look;
        ctx.save(); ctx.beginPath(); ctx.rect(0, game.y, W, game.h); ctx.clip(); ctx.drawImage(v, box.x, box.y + game.y, box.w, box.h); ctx.restore();
        if (e.frame.mode === "pip") { ctx.fillStyle = "#ffffff"; ctx.fillRect(fp.x - 4, fp.y - 4, fp.w + 8, fp.h + 8); }
        ctx.drawImage(v, fp.sx, fp.sy, fp.sw, fp.sh, fp.x, fp.y, fp.w, fp.h);
        ctx.filter = "none";
        const divider = e.frame.split?.divider;
        if (e.frame.mode === "cam" && divider) { ctx.fillStyle = divider; ctx.fillRect(0, camAreas(e.frame).seam - 3, W, 6); }
      } else if (v.readyState >= 2) {
        if (e.frame.mode === "blur") {
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
      const chatNow = e.chat?.on ? chatRef.current.find(w => t >= w.start && t < w.end) : null;
      if (chatNow) drawChat(ctx, chatNow.lines, 40, e.chat!.y * H, W - 80);
      const c = e.captions, hit = c.on ? activeCue(cueRef.current, rel) : null;
      if (hit) {
        const { cue, word } = hit, w = cue.words[word];
        const y = c.y * H;
        // A keyword (w.k) stands out in the keyword colour, or the highlight while it's spoken, and bigger.
        if (c.animation === "word") drawText(ctx, [{ t: w.t, color: w.k ? c.keywordColor : c.color, big: w.k }], c, W / 2, y, "middle", pop(rel - w.s));
        else drawText(ctx, cue.words.map((x: { t: string; k?: boolean }, i: number) => ({ t: x.t, big: x.k, color: c.animation === "karaoke" && i === word ? c.highlight : x.k ? c.keywordColor : c.color })), c, W / 2, y, "middle", c.animation === "pop" || c.animation === "karaoke" ? pop(rel - cue.start) : 1);
      }
      // Word by word (wrapped like the render), with the hook's own line breaks.
      const hp = hookPlacement(e), placing = v.paused && tabRef.current === "extras";
      hookBox.current = e.hook.text && (out < e.hook.seconds || placing) ? drawText(ctx, e.hook.text.split("\n").flatMap((l, i) => [...(i ? [{ t: "\n", color: e.hook.color }] : []), ...l.split(" ").filter(Boolean).map(t => ({ t, color: e.hook.color }))]),
        e.hook.bg ? { font: c.font, size: hp.size, outline: 0, outlineColor: "#000000", box: true, boxColor: e.hook.bg } : { font: c.font, size: hp.size, outline: Math.max(3, Math.round(hp.size * HOOK_OUTLINE / 52)), outlineColor: hookOutlineColor(e.hook.color), box: false, boxColor: "#000000" },
        hp.x, hp.y, "top", placing ? 1 : pop(out), 60, hp.wrap) : null;
      if (hookBox.current && placing) { const b = hookBox.current; ctx.save(); ctx.setLineDash([10, 8]); ctx.lineWidth = 3; ctx.strokeStyle = "#bcfa76"; ctx.strokeRect(b.left - 16, b.top - 8, b.right - b.left + 32, b.bottom - b.top + 16); ctx.restore(); }
      if (e.progress.on) { ctx.fillStyle = e.progress.color; ctx.fillRect(0, H - 10, W * clamp(out / clipLen, 0, 1), 10); }
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

  // Drag the hook to place it, or anywhere else to reposition the picture within the room the zoom leaves.
  const drag = useRef<{ x: number; y: number; fx: number; fy: number; hook?: boolean } | null>(null);
  const onHook = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const b = hookBox.current, cv = canvas.current;
    if (!b || !cv || !editRef.current) return false;
    const r = cv.getBoundingClientRect(), s = frameSize(editRef.current.frame).W / r.width, x = (ev.clientX - r.left) * s, y = (ev.clientY - r.top) * s;
    return x >= b.left - 24 && x <= b.right + 24 && y >= b.top - 16 && y <= b.bottom + 16;
  };
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!edit) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    drag.current = onHook(ev) ? { x: ev.clientX, y: ev.clientY, fx: edit.hook.x, fy: edit.hook.y, hook: true } : { x: ev.clientX, y: ev.clientY, fx: edit.frame.x, fy: edit.frame.y };
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, cv = canvas.current, v = video.current;
    if (!d) { ev.currentTarget.style.cursor = onHook(ev) ? "move" : ""; return; }
    if (!cv || !bundle) return;
    const r = cv.getBoundingClientRect();
    if (d.hook) {
      const round = (n: number) => Math.round(n * 1000) / 1000;
      change("hook-move", e => ({ ...e, hook: { ...e.hook, x: round(clamp(d.fx + (ev.clientX - d.x) / r.width, HOOK_X[0], HOOK_X[1])), y: round(clamp(d.fy + (ev.clientY - d.y) / r.height, HOOK_Y[0], HOOK_Y[1])) } }));
      return;
    }
    const scale = frameSize(editRef.current!.frame).W / r.width;
    const box = layout({ ...editRef.current!.frame, x: 0, y: 0 }, v?.videoWidth || bundle.source.width, v?.videoHeight || bundle.source.height);
    const roomX = Math.abs(box.area.w - box.w) / 2, roomY = Math.abs(box.area.h - box.h) / 2;
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

  const captionAction = async (body: { action: "save"; text: string }) => {
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

  const generateOpeningHook = () => {
    // Explicit regeneration uses the current unsaved trim/word corrections, just like the preview.
    const generated = applyAutomaticHook({ ...edit, hook: { ...edit.hook, text: "" } }, words);
    setTab("extras");
    if (!generated.hook.text) {
      setHookNote("No usable speech in the current trim. Correct the transcript, widen the trim, or type a hook below. Your current hook has been kept.");
      return;
    }
    change("generate-hook", e => ({ ...e, hook: generated.hook }));
    video.current?.pause();
    if (video.current) video.current.currentTime = edit.trim.start;
    setPlaying(false); setTime(edit.trim.start);
    setHookNote("Hook generated locally from the current transcript. Preview it, then Save edit to render it into the video. Undo restores the previous hook.");
  };
  const c = edit.captions, len = edit.trim.end - edit.trim.start, finished = tl?.length ?? len, pace = { cuts: "off", zooms: false, ...edit.pace } as Pace;
  const cutTotal = Math.round((len - finished) * 10) / 10;
  // Split-screen backgrounds long enough for this clip (as trimmed now); a library video of unknown length counts.
  const fits = (d?: number | null) => !d || d + 0.05 >= len, secs = (n: number) => n >= 60 ? Math.floor(n / 60) + ":" + String(Math.round(n % 60)).padStart(2, "0") : Math.round(n) + "s";
  const fitLibrary = backgrounds.filter(b => fits(b.duration)), fitClips = bgClips.filter(c => c.duration + 0.05 >= len);
  const hiddenShort = backgrounds.length - fitLibrary.length + bgClips.length - fitClips.length;
  const chosen = edit.frame.background, chosenTooShort = !!chosen && !fitLibrary.some(b => b.id === chosen) && !fitClips.some(c => "clip:" + c.id === chosen);
  const bgPreview = chosen ?? fitLibrary[0]?.id ?? null;
  const bgIsImage = !!bgPreview && !!backgrounds.find(b => b.id === bgPreview)?.content_type?.startsWith("image/");
  // Split screen's proportions, order, divider and background sound. Moving the seam moves the captions with it.
  const setSplit = (value: Partial<Split>) => change("frame-split" + Object.keys(value).join(), e => {
    const split = { ...DEFAULT_SPLIT, ...e.frame.split, ...value } as Split;
    const moved = value.share !== undefined || value.top !== undefined;
    return { ...e, frame: { ...e.frame, split }, captions: moved ? { ...e.captions, y: splitAreas({ ...e.frame, split }).seam / frameSize(e.frame).H } : e.captions };
  });
  const set = <K extends keyof Edit>(key: K, value: Partial<Edit[K]>) => change(String(key) + Object.keys(value).join(), e => ({ ...e, [key]: { ...(e[key] as object), ...value } }));
  const setCaption = (value: Partial<Captions>) => change("captions" + Object.keys(value).join(), e => ({ ...e, captions: { ...e.captions, ...value, preset: "preset" in value ? value.preset! : "custom" } }));
  const maxChat = Math.max(1, ...(bundle.signals?.chat ?? [0]));
  const pct = (t: number) => (t / duration) * 100;
  const editWord = (i: number, text: string) => change("word" + i, e => { const list = [...(e.words ?? bundle.words)].map(w => [...w] as Word); list[i][2] = text.replace(/[{}\\\r\n]/g, "").slice(0, 40); return { ...e, words: list }; });

  return <div className="editor-shell" role="dialog" aria-label="Clip editor">
    <header className="editor-top">
      <button className="secondary" onClick={onClose}><ArrowLeft size={16} />Clips</button>
      <div className="editor-title"><strong>{bundle.streamer ?? "Clip"}</strong><small>{new Date(bundle.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {finished.toFixed(1)}s{bundle.render.state === "queued" ? " · rendering a saved edit" : bundle.render.state === "failed" ? " · last render failed" : ""}</small></div>
      <div className="editor-actions">
        <button className="icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
        <button className="icon-button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button>
        <button className="icon-button" aria-label="Discard changes" title="Discard changes" disabled={!past.length} onClick={() => { setPast(p => [...p, edit]); setEditState(bundle.edit); }}><RotateCcw size={16} /></button>
        {onCopied && <button className="secondary" disabled={saving || copying || past.length > 0} title={past.length ? "Save or discard your changes first: the copy starts from the saved clip" : "A second clip from the same footage, to give another hook or look and post to other accounts"} onClick={() => void makeCopy()}>{copying ? <Loader2 className="spin" size={16} /> : <Copy size={16} />}Make a copy</button>}
        <label className="editor-check" title={"New clips from " + (bundle.streamer ?? "this streamer") + " start with this framing, look and caption style"}><input type="checkbox" checked={saveStyle} onChange={e => setSaveStyle(e.target.checked)} />Use this look for {bundle.streamer ?? "this streamer"}&apos;s new clips</label>
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}Save &amp; render</button>
      </div>
    </header>
    {error && <div className="error editor-error" role="alert">{error}</div>}
    {bundle.render.state === "failed" && bundle.render.error && <div className="error editor-error" role="status">The last render failed: {bundle.render.error}. Saving again retries it.</div>}
    {!bundle.sourceStored && <div className="notice editor-error"><p>The editable source isn&apos;t in clip storage yet, so the preview can&apos;t play. The worker still re-renders your edits while it keeps this clip.</p></div>}
    <div className="editor-body">
      <section className="editor-stage">
        <div className={"phone" + (stacks(edit.frame) ? "" : " landscape")} style={{ aspectRatio: frameSize(edit.frame).W + " / " + frameSize(edit.frame).H }}>
          <canvas ref={canvas} width={frameSize(edit.frame).W} height={frameSize(edit.frame).H} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} title="Drag to reposition the picture, or drag the hook to move it" />
          {safe && <div className="safe-zones" aria-hidden><span className="sz-top" /><span className="sz-right">App buttons</span><span className="sz-bottom">Username &amp; caption</span></div>}
        </div>
        {edit.frame.mode === "split" && bgPreview && bgIsImage && <img ref={bgImage} key={bgPreview} src={"/api/backgrounds/" + bgPreview + "/file"} alt="" hidden />}
        {edit.frame.mode === "split" && bgPreview && !bgIsImage && <video ref={bgVideo} className="editor-video" key={bgPreview} src={bgPreview.startsWith("clip:") ? "/api/clips/" + bgPreview.slice(5) + "/source" : "/api/backgrounds/" + bgPreview + "/file"} muted loop playsInline preload="auto" />}
        <video ref={video} className="editor-video" src={bundle.sourceStored ? "/api/clips/" + clipId + "/source" : undefined} playsInline preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => { e.currentTarget.currentTime = edit.trim.start; }} />
        <div className="stage-controls">
          <button className="icon-button play" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
          <span className="timecode">{fmt(Math.max(0, tl ? tl.toClip(time - edit.trim.start) : time - edit.trim.start))} / {fmt(finished)}</span>
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
            {tl?.cuts.map(([a, b]) => <div key={a} className="heat-cut" title={"Jump cut: " + (b - a).toFixed(1) + "s pause"} style={{ left: pct(edit.trim.start + a) + "%", width: pct(b - a) + "%" }} />)}
            <div className="playhead" style={{ left: pct(time) + "%" }} />
          </div>
          {bundle.signals && <div className="heat-legend"><span><i className="loud" />Loudness</span><span><i className="chat" />Chat activity</span><span className="muted">Why this moment was clipped</span></div>}
        </div>
        <div className="editor-tabs" role="tablist">{(["captions", "frame", "extras", "transcript", "post"] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{{ captions: "Captions", frame: "Frame & look", extras: "Hook & extras", transcript: "Transcript", post: "Post caption" }[t]}</button>)}</div>
        <div className="editor-controls">
          {bundle.legacy && (tab === "captions" || tab === "transcript") && <div className="subtle-note">This clip was captured before the editor existed, so its captions are part of the picture and can&apos;t be restyled or corrected. You can still trim it, reframe it, adjust its colour, and add a hook title and progress bar. Clips captured from now on are fully editable.</div>}
          {tab === "post" && <>
            <p className="hint">The text posted with this clip on Instagram, TikTok and YouTube. The first line is also the YouTube title. {bundle.caption.ai ? "Automatic post captions use the saved transcript. Edit this text manually, or generate an on-screen opening hook below." : "Automatic post captions are disabled in Settings. Type your own post text here; the hook generator adds a title to the video."}</p>
            <label className="wide">Caption <small>{captionSource === "local" ? "Created from transcript" : captionSource === "ai" ? "Written by the AI writer on your PC" : captionSource === "edited" ? "Your text: never automatically replaced" : "Not written yet: " + (bundle.caption.ai ? "created from the transcript before posting" : "the template is used")}</small>
              <textarea rows={9} maxLength={2200} value={postText} onChange={e => setPostText(e.target.value)} placeholder={bundle.caption.ai ? "Leave empty to use an automatic caption or fallback" : "Type the caption to post with this clip"} /></label>
            <div className="caption-actions"><span className="muted">{postText.length} / 2200</span>
              <button className="secondary" disabled={saving} title="Generate an on-screen opening title from the current transcript" onClick={generateOpeningHook}><Sparkles size={15} />Generate hook</button>
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
              <label className="color" title="The colour of each line's most important word">Key words<input type="color" value={c.keywordColor} disabled={!c.keywords} onChange={e => setCaption({ keywordColor: e.target.value })} /></label>
              <label className="color">Outline<input type="color" value={c.outlineColor} onChange={e => setCaption({ outlineColor: e.target.value })} /></label>
              <label className="color">Box<input type="color" value={c.boxColor} onChange={e => setCaption({ boxColor: e.target.value })} /></label>
            </div>
            <div className="toggles">
              <label><input type="checkbox" checked={c.box} onChange={e => setCaption({ box: e.target.checked })} />Background box</label>
              <label><input type="checkbox" checked={c.uppercase} onChange={e => setCaption({ uppercase: e.target.checked })} />ALL CAPS</label>
              <label title="Each line's most important word (a strong word, a number, a name, or one that was shouted) in its own colour and a little bigger"><input type="checkbox" checked={c.keywords} onChange={e => setCaption({ keywords: e.target.checked })} />Highlight key words</label>
              <label title="Replaces swear words with asterisks, e.g. f***, which keeps clips safer for brand-friendly accounts"><input type="checkbox" checked={c.mask} onChange={e => setCaption({ mask: e.target.checked })} />Bleep swear words in captions</label>
            </div>
          </>}
          {tab === "frame" && <>
            <label className="wide">Clip shape<div className="segmented aspect-picker">{(Object.keys(ASPECTS) as Aspect[]).map(a => <button key={a} type="button" className={(edit.frame.aspect ?? "9:16") === a ? "active" : ""} title={ASPECT_LABELS[a]} onClick={() => change("frame-aspect", e => {
              // A landscape clip can't stack two pictures: split screen and facecam-on-top become the blurred fill there.
              const frame = { ...e.frame, aspect: a }, flat = !stacks(frame) && (e.frame.mode === "split" || e.frame.mode === "cam");
              return { ...e, frame: flat ? { ...frame, mode: "blur" } : frame, captions: flat ? { ...e.captions, y: 0.72 } : e.captions };
            })}><span className={"aspect-icon a" + a.replace(":", "x")} aria-hidden />{a}</button>)}</div>
              <small>{ASPECT_LABELS[(edit.frame.aspect ?? "9:16") as Aspect]}. {(edit.frame.aspect ?? "9:16") === "9:16" ? "Best for TikTok, Reels and Shorts." : (edit.frame.aspect === "16:9" ? "For YouTube videos and X; TikTok and Reels show it with bars, and YouTube doesn't treat it as a Short." : "Fills more of the feed on Instagram and Facebook; TikTok shows it with bars.")}</small></label>
            <div className="segmented">{(["blur", "crop", "fit", "phone", "split", "cam", "pip"] as const).map(m => <button key={m} className={edit.frame.mode === m ? "active" : ""} disabled={!stacks(edit.frame) && (m === "split" || m === "cam")} title={!stacks(edit.frame) && (m === "split" || m === "cam") ? "Needs a portrait or square clip shape" : undefined} onClick={() => change("frame-mode", e => {
              const facecam = { ...DEFAULT_FACECAM, ...e.frame.facecam } as Facecam, H = frameSize(e.frame).H;
              if ((m === "cam" || m === "pip") && !facecam.box) facecam.box = bundle.source.face ?? null;
              const content = m === "phone" && !e.frame.content ? bundle.source.content ?? null : e.frame.content ?? null;
              // Captions follow the seam in the layouts that have one, and go back to the lower third otherwise.
              const seam = m === "split" ? splitAreas(e.frame).seam / H : m === "cam" ? camAreas({ ...e.frame, facecam }).seam / H : 0.72;
              const atSeam = Math.abs(e.captions.y - 0.72) < 0.01 || (e.frame.mode === "split" && Math.abs(e.captions.y - splitAreas(e.frame).seam / H) < 0.01) || (e.frame.mode === "cam" && Math.abs(e.captions.y - camAreas(e.frame).seam / H) < 0.01);
              return { ...e, frame: { ...e.frame, mode: m, facecam, content }, captions: atSeam ? { ...e.captions, y: seam } : e.captions };
            })}>{{ blur: "Blurred fill", crop: "Fill (crop)", fit: "Fit with bars", phone: "Phone stream", split: "Split screen", cam: "Facecam + game", pip: "Facecam in corner" }[m]}</button>)}</div>
            {edit.frame.mode === "phone" && (() => {
              // The phone picture's edges in the stream (fractions). Without one, an upright picture in the middle.
              const sw = bundle.source.width || 1280, sh = bundle.source.height || 720, auto = Math.min(1, (sh * 9 / 16) / sw);
              const b = edit.frame.content ?? { x: (1 - auto) / 2, y: 0, w: auto, h: 1 };
              const setContent = (value: Partial<CamBox> | null) => change("frame-content" + (value ? Object.keys(value).join() : ""), e => {
                if (!value) return { ...e, frame: { ...e.frame, content: null } };
                const nb = { ...b, ...value }; nb.w = clamp(nb.w, 0.05, 1); nb.h = clamp(nb.h, 0.05, 1); nb.x = clamp(nb.x, 0, 1 - nb.w); nb.y = clamp(nb.y, 0, 1 - nb.h);
                return { ...e, frame: { ...e.frame, content: nb } };
              });
              const found = bundle.source.content, usingFound = !!found && edit.frame.content === found;
              return <div className="facecam-controls">
                <small>{usingFound ? "Phone picture found automatically. " : edit.frame.content ? "" : found === undefined ? "This clip was captured before phone detection: an upright picture in the middle is assumed. " : "No black bars were found, so an upright picture in the middle is used. "}Move the edges until only the phone picture shows; it fills the clip.
                  {found && !usingFound && <> <button type="button" className="text-button" onClick={() => setContent(found)}>Use the detected picture</button></>}
                  {edit.frame.content && <> <button type="button" className="text-button" onClick={() => setContent(null)}>Centre it automatically</button></>}</small>
                <div className="control-grid">
                  <label>Picture left <span>{Math.round(b.x * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b.x} onChange={e => setContent({ x: Number(e.target.value) })} /></label>
                  <label>Picture width <span>{Math.round(b.w * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b.w} onChange={e => setContent({ w: Number(e.target.value) })} /></label>
                  <label>Picture top <span>{Math.round(b.y * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b.y} onChange={e => setContent({ y: Number(e.target.value) })} /></label>
                  <label>Picture height <span>{Math.round(b.h * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b.h} onChange={e => setContent({ h: Number(e.target.value) })} /></label>
                </div>
              </div>;
            })()}
            {(edit.frame.mode === "cam" || edit.frame.mode === "pip") && (() => {
              const fc = { ...DEFAULT_FACECAM, ...edit.frame.facecam } as Facecam, b = fc.box;
              const setCam = (value: Partial<Facecam>) => change("frame-facecam" + Object.keys(value).join(), e => {
                const facecam = { ...DEFAULT_FACECAM, ...e.frame.facecam, ...value } as Facecam;
                const moved = value.share !== undefined && e.frame.mode === "cam";
                return { ...e, frame: { ...e.frame, facecam }, captions: moved ? { ...e.captions, y: camAreas({ ...e.frame, facecam }).seam / frameSize(e.frame).H } : e.captions };
              });
              const setBox = (value: Partial<CamBox>) => { const nb = { ...(b ?? { x: 0, y: 0, w: 0.3, h: 0.4 }), ...value }; nb.w = Math.min(1, Math.max(0.05, nb.w)); nb.h = Math.min(1, Math.max(0.05, nb.h)); nb.x = Math.min(1 - nb.w, Math.max(0, nb.x)); nb.y = Math.min(1 - nb.h, Math.max(0, nb.y)); setCam({ box: nb }); };
              return <div className="facecam-controls">
                <small>{b ? (bundle.source.face && b === bundle.source.face ? "Webcam found automatically. " : "") + "Adjust the box until only the webcam shows." : bundle.source.face === undefined ? "This clip was captured before webcam detection. Place the box over the webcam." : "No webcam overlay was found in this clip (or it fills the picture). Place the box over the webcam, or pick another framing."}
                  {bundle.source.face && b !== bundle.source.face && <> <button type="button" className="text-button" onClick={() => setCam({ box: bundle.source.face! })}>Use the detected webcam</button></>}</small>
                <div className="control-grid">
                  <label>Webcam left <span>{Math.round((b?.x ?? 0) * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b?.x ?? 0} onChange={e => setBox({ x: Number(e.target.value) })} /></label>
                  <label>Webcam top <span>{Math.round((b?.y ?? 0) * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b?.y ?? 0} onChange={e => setBox({ y: Number(e.target.value) })} /></label>
                  <label>Webcam width <span>{Math.round((b?.w ?? 0.3) * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b?.w ?? 0.3} onChange={e => setBox({ w: Number(e.target.value) })} /></label>
                  <label>Webcam height <span>{Math.round((b?.h ?? 0.4) * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b?.h ?? 0.4} onChange={e => setBox({ h: Number(e.target.value) })} /></label>
                  {edit.frame.mode === "cam" ? <label>Facecam strip <span>{Math.round(fc.share * 100)}%</span><input type="range" min={0.2} max={0.5} step={0.01} value={fc.share} onChange={e => setCam({ share: Number(e.target.value) })} /></label>
                    : <><label>Corner<select value={fc.corner} onChange={e => setCam({ corner: e.target.value as Facecam["corner"] })}><option value="tl">Top left</option><option value="tr">Top right</option><option value="bl">Bottom left</option><option value="br">Bottom right</option></select></label>
                      <label>Box size <span>{Math.round(fc.size * 100)}%</span><input type="range" min={0.2} max={0.5} step={0.01} value={fc.size} onChange={e => setCam({ size: Number(e.target.value) })} /></label></>}
                  {edit.frame.mode === "cam" && <label>Divider line<div className="color-pair"><input type="checkbox" checked={!!edit.frame.split?.divider} onChange={e => setSplit({ divider: e.target.checked ? "#ffffff" : null })} />{edit.frame.split?.divider && <input type="color" value={edit.frame.split.divider} onChange={e => setSplit({ divider: e.target.value })} />}</div></label>}
                </div>
                <small>Zoom and position below move the game.</small>
              </div>;
            })()}
            {edit.frame.mode === "split" && <label className="wide">Background
              <select value={edit.frame.background ?? ""} onChange={e => set("frame", { background: e.target.value || null })}>
                <option value="">Picked from your library for this clip</option>
                {fitLibrary.length > 0 && <optgroup label="Background library">{fitLibrary.map(b => <option key={b.id} value={b.id}>{b.name}{b.content_type?.startsWith("image/") ? " · image" : b.duration ? " · " + secs(b.duration) : ""}</option>)}</optgroup>}
                {fitClips.length > 0 && <optgroup label="Your clips">{fitClips.map(c => <option key={c.id} value={"clip:" + c.id}>{(c.streamer ?? "Clip") + " · " + secs(c.duration) + " · " + new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</option>)}</optgroup>}
                {chosenTooShort && <option value={edit.frame.background!}>Chosen video (shorter than this clip)</option>}
              </select>
              <small>{chosenTooShort ? "The chosen video is shorter than this clip now; pick another, or the render uses one from your library."
                : fitLibrary.length + fitClips.length ? "Only videos at least as long as this clip (" + secs(len) + ") are listed; longer ones are cut to fit, from a different point in each clip." + (hiddenShort ? " " + hiddenShort + " shorter " + (hiddenShort === 1 ? "one is" : "ones are") + " hidden." : "")
                : "Nothing is long enough yet: upload longer loops in Settings → Split-screen backgrounds. Until then the clip renders with the blurred fill."}</small></label>}
            {edit.frame.mode === "split" && (() => { const sp = { ...DEFAULT_SPLIT, ...edit.frame.split } as Split; return <div className="control-grid">
              <label>Stream size<select value={sp.share} onChange={e => setSplit({ share: Number(e.target.value) })}>
                {[[0.5, "Half and half"], [0.6, "Stream 60%"], [0.7, "Stream 70%"], [0.8, "Stream 80%"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                {![0.5, 0.6, 0.7, 0.8].includes(sp.share) && <option value={sp.share}>Stream {Math.round(sp.share * 100)}%</option>}</select></label>
              <label>Stream position<select value={sp.top} onChange={e => setSplit({ top: e.target.value as Split["top"] })}><option value="stream">On top</option><option value="background">At the bottom</option></select></label>
              <label>Divider line<div className="color-pair"><input type="checkbox" checked={!!sp.divider} onChange={e => setSplit({ divider: e.target.checked ? "#ffffff" : null })} />{sp.divider && <input type="color" value={sp.divider} onChange={e => setSplit({ divider: e.target.value })} />}</div></label>
              <label>Background sound <span>{bgIsImage ? "image" : Math.round(sp.volume * 100) + "%"}</span><input type="range" min={0} max={1} step={0.05} value={sp.volume} disabled={bgIsImage} onChange={e => setSplit({ volume: Number(e.target.value) })} /></label>
            </div>; })()}
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
            <p className="hint">The same local hook generator used during clipping. Uses your current trim and transcript corrections; no API key needed.</p>
            <button className="secondary" disabled={saving} onClick={generateOpeningHook}><Sparkles size={15} />{edit.hook.text ? "Regenerate hook" : "Generate hook"}</button>
            {hookNote && <p className="hint" role="status">{hookNote}</p>}
            <label className="wide">Hook title <small>Shown at the top for the first seconds, to stop the scroll. Press Enter for a new line (up to {HOOK_LINES} lines). Pause and drag it on the preview to move it.</small>
              <textarea className="hook-text" rows={Math.min(HOOK_LINES, Math.max(2, edit.hook.text.split("\n").length))} maxLength={90} placeholder={"e.g. He did NOT\nsee that coming"} value={edit.hook.text}
                onKeyDown={e => { if (e.key === "Enter" && edit.hook.text.split("\n").length >= HOOK_LINES) e.preventDefault(); }}
                onChange={e => set("hook", { text: e.target.value.split("\n").slice(0, HOOK_LINES).join("\n") })} /></label>
            <div className="control-grid">
              <label>Hook length <span>{edit.hook.seconds >= len ? "Whole clip" : edit.hook.seconds + "s"}</span><input type="range" min={1} max={Math.max(1, Math.min(30, Math.floor(len)))} step={0.5} value={Math.min(edit.hook.seconds, Math.max(1, Math.min(30, Math.floor(len))))} disabled={edit.hook.seconds >= len} onChange={e => set("hook", { seconds: Number(e.target.value) })} />
                <span className="check-inline"><input type="checkbox" checked={edit.hook.seconds >= len} onChange={e => set("hook", { seconds: e.target.checked ? 90 : 5 })} />Keep for the whole clip</span></label>
              <label>Hook size <span>{edit.hook.size}px</span><input type="range" min={HOOK_SIZE[0]} max={HOOK_SIZE[1]} step={2} value={edit.hook.size} onChange={e => set("hook", { size: Number(e.target.value) })} /></label>
              <label>Hook left / right <span>{Math.round(edit.hook.x * 100)}%</span><input type="range" min={HOOK_X[0]} max={HOOK_X[1]} step={0.005} value={edit.hook.x} onChange={e => set("hook", { x: Number(e.target.value) })} /></label>
              <label>Hook up / down <span>{Math.round(edit.hook.y * 100)}% down</span><input type="range" min={HOOK_Y[0]} max={HOOK_Y[1]} step={0.005} value={edit.hook.y} onChange={e => set("hook", { y: Number(e.target.value) })} />
                <span className="check-inline"><button type="button" className="text-button" onClick={() => set("hook", { ...HOOK_DEFAULT })}>Reset hook size and place</button></span></label>
              <label className="color">Hook text<input type="color" value={edit.hook.color} onChange={e => set("hook", { color: e.target.value })} /></label>
              <label className="color" title="Turn off for the text alone, with an outline so it stays readable">Hook background<div className="color-pair"><input type="checkbox" aria-label="Show a hook background" checked={!!edit.hook.bg} onChange={e => set("hook", { bg: e.target.checked ? "#ffffff" : null })} />{edit.hook.bg && <input type="color" value={edit.hook.bg} onChange={e => set("hook", { bg: e.target.value })} />}</div></label>
            </div>
            <div className="pace-controls">
              <label className="wide">Jump cuts <small>Takes quiet pauses out between words. Pauses full of game sound or shouting are kept, and so are the opening and ending.</small>
                <div className="segmented">{(["off", "gentle", "tight"] as const).map(level => <button key={level} type="button" className={pace.cuts === level ? "active" : ""} onClick={() => change("pace-cuts", e => ({ ...e, pace: { ...pace, ...e.pace, cuts: level } }))}>{{ off: "Off", gentle: "Gentle", tight: "Tight" }[level]}</button>)}</div>
                {pace.cuts !== "off" && <small role="status">{bundle.legacy || !words.length ? "This clip has no transcript, so there are no pauses to find." : tl?.cuts.length ? `Takes out ${tl.cuts.length} pause${tl.cuts.length === 1 ? "" : "s"} (${cutTotal}s): the clip becomes ${finished.toFixed(1)}s. Marked in the timeline.` : "No pauses long and quiet enough to cut in this trim."}</small>}</label>
              <label className="switch-row"><input type="checkbox" checked={pace.zooms} onChange={e => { const on = e.target.checked; change("pace-zooms", x => ({ ...x, pace: { ...pace, ...x.pace, zooms: on } })); }} />Punch-in zooms on the loudest moments <small>{pace.zooms ? (tl?.punches.length ? tl.punches.length + " zoom" + (tl.punches.length === 1 ? "" : "s") + " at " + tl.punches.map(p => p.toFixed(1) + "s").join(", ") : energy ? "No moment stands out enough in this trim." : "Needs the loudness the worker records; this clip has none.") : "A quick zoom on a shout, a punchline or a big play"}</small></label>
            </div>
            <label className="switch-row"><input type="checkbox" disabled={!messages?.length} checked={!!edit.chat?.on} onChange={e => { const on = e.target.checked; change("chat-on", x => ({ ...x, chat: { ...DEFAULT_CHAT, ...x.chat, on } })); }} />Show chat on the clip <small>{messages?.length ? "The Twitch chat sent during this moment, a few messages at a time, like watching it live (" + messages.length + " messages)" : "Only clips captured live from Twitch keep their chat."}</small></label>
            {edit.chat?.on && <label>Chat position <span>{Math.round(edit.chat.y * 100)}% down</span><input type="range" min={15} max={95} value={Math.round(edit.chat.y * 100)} onChange={e => { const y = Number(e.target.value) / 100; change("chat-y", x => ({ ...x, chat: { ...DEFAULT_CHAT, ...x.chat, y } })); }} /></label>}
            <label className="wide">Background music <small>Copyrighted music in a clip can get it muted or taken down. Your worker PC separates the voice from everything else when it renders (it can take a few minutes); the preview here plays the original sound.</small>
              <div className="segmented">{([["keep", "As recorded"], ["lower", "Turn music down"], ["voice", "Voice only"]] as const).map(([mode, label]) => <button key={mode} type="button" className={(edit.audio?.music ?? "keep") === mode ? "active" : ""} onClick={() => change("audio-music", x => ({ ...x, audio: { ...x.audio, music: mode } }))}>{label}</button>)}</div>
              {(edit.audio?.music ?? "keep") !== "keep" && <small role="status">{edit.audio?.music === "voice" ? "Keeps only the voice: music and game sound are gone too. The safest against copyright claims." : "The voice stays; music and game sound play quietly underneath."}</small>}</label>
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
