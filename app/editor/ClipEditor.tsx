"use client";
// The clip editor, in four steps: Cut & frame, Text, Extras, Review & post. The preview (Stage) is drawn from the same
// layout and caption code (worker/edit.mjs) the worker renders with; the timeline under it shows every layer on one
// scale. Saving stores the edit (and a saved version of it); the worker re-renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { DEFAULT_SPLIT, HOOK_DEFAULT, MAX_CLIP, MIN_CLIP, canvas as frameSize, chatWindows, cues, splitAreas, timeline } from "../../worker/edit.mjs";
import { apiFetch, readJson } from "../../lib/read-json.mjs";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { CutFrame } from "./steps/CutFrame";
import { Text, type TextPanel } from "./steps/Text";
import { Extras } from "./steps/Extras";
import { Review } from "./steps/Review";
import { backgroundChoice, type BgClip, type BgVideo } from "./backgrounds";
import { STEPS, clamp, type Bundle, type Change, type Edit, type Split, type Step, type Tools, type Word } from "./types";

export type { Edit } from "./types";

// `onCopied`: a copy of this clip was made (Make a copy); the workspace opens it.
export default function ClipEditor({ clipId, onClose, onSaved, onCopied }: { clipId: string; onClose: () => void; onSaved: (message: string) => void; onCopied?: (id: string, message: string) => void }) {
  const [bundle, setBundle] = useState<Bundle | null>(null), [error, setError] = useState(""), [saving, setSaving] = useState(false), [copying, setCopying] = useState(false);
  const [edit, setEditState] = useState<Edit | null>(null), [past, setPast] = useState<Edit[]>([]), [future, setFuture] = useState<Edit[]>([]);
  const [step, setStep] = useState<Step>("cut"), [panel, setPanel] = useState<TextPanel>("subtitles"), [time, setTime] = useState(0), [saveStyle, setSaveStyle] = useState(false), [restored, setRestored] = useState<number | null>(null);
  const [backgrounds, setBackgrounds] = useState<BgVideo[]>([]), [bgClips, setBgClips] = useState<BgClip[]>([]);
  const video = useRef<HTMLVideoElement>(null), editRef = useRef<Edit | null>(null), lastPush = useRef({ at: 0, key: "" });

  useEffect(() => {
    fetch("/api/backgrounds?for=" + clipId).then(r => (r.ok ? r.json() : {}) as Promise<{ backgrounds?: BgVideo[]; clips?: BgClip[] }>).then(b => { setBackgrounds(b.backgrounds ?? []); setBgClips(b.clips ?? []); }).catch(() => {});
  }, [clipId]);
  useEffect(() => {
    let live = true;
    apiFetch("/api/clips/" + clipId + "/edit").then(async r => { const body = await readJson<Bundle & { error?: string }>(r); if (!r.ok) throw new Error(body.error); return body; })
      .then(b => { if (!live) return; setBundle(b); setEditState(b.edit && { ...b.edit, hook: { ...HOOK_DEFAULT, ...b.edit.hook } }); })
      .catch(e => live && setError(e instanceof Error ? e.message : "Couldn't open this clip."));
    return () => { live = false; };
  }, [clipId]);

  // Unsaved changes: closing (Esc, the Clips button) or leaving the page asks first instead of dropping them.
  const opened = useMemo(() => bundle?.edit ? JSON.stringify({ ...bundle.edit, hook: { ...HOOK_DEFAULT, ...bundle.edit.hook } }) : null, [bundle]);
  const dirty = !!edit && !!opened && JSON.stringify(edit) !== opened, dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty && !saving; }, [dirty, saving]);
  const close = useCallback(() => { if (dirtyRef.current && !window.confirm("Leave without saving your changes to this clip?")) return; onClose(); }, [onClose]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  // Every change goes through here. Rapid changes to the same control (a slider drag) become one undo step.
  const change: Change = useCallback((key, next) => {
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

  const tools: Tools = useMemo(() => ({
    change,
    set: (key, value) => change(String(key) + Object.keys(value).join(), e => ({ ...e, [key]: { ...(e[key] as object), ...value } })),
    setCaption: value => change("captions" + Object.keys(value).join(), e => ({ ...e, captions: { ...e.captions, ...value, preset: "preset" in value ? value.preset! : "custom" } })),
    // Split screen's proportions, order, divider and background sound. Moving the seam moves the captions with it.
    setSplit: value => change("frame-split" + Object.keys(value).join(), e => {
      const split = { ...DEFAULT_SPLIT, ...e.frame.split, ...value } as Split;
      const moved = value.share !== undefined || value.top !== undefined;
      return { ...e, frame: { ...e.frame, split }, captions: moved ? { ...e.captions, y: splitAreas({ ...e.frame, split }).seam / frameSize(e.frame).H } : e.captions };
    }),
  }), [change]);

  const duration = bundle?.source.duration ?? 0;
  const words: Word[] = useMemo(() => edit?.words ?? bundle?.words ?? [], [edit?.words, bundle?.words]);
  const cueList = useMemo(() => edit ? cues(words, edit) : [], [words, edit]);
  const energy = bundle?.signals?.energy ?? null, messages = bundle?.signals?.messages ?? null;
  const tl = useMemo(() => edit ? timeline(edit, words, energy) : null, [edit, words, energy]);
  const chatList = useMemo(() => edit && messages ? chatWindows(messages, edit) : [], [messages, edit]);

  const seek = useCallback((t: number) => { const v = video.current, e = editRef.current; if (v && e) v.currentTime = clamp(t, 0, duration); }, [duration]);
  const setTrim = useCallback((which: "start" | "end", t: number) => change("trim-" + which, e => {
    let { start, end } = e.trim;
    if (which === "start") start = clamp(t, Math.max(0, end - MAX_CLIP), end - MIN_CLIP); else end = clamp(t, start + MIN_CLIP, Math.min(duration, start + MAX_CLIP));
    return { ...e, trim: { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 } };
  }), [change, duration]);
  const toggle = useCallback(() => { const v = video.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }, []);
  // A saved version opens as unsaved changes (undo goes back), its trim kept inside this clip's source.
  const restore = useCallback((saved: Edit, rev: number) => {
    const start = clamp(saved.trim.start, 0, Math.max(0, duration - MIN_CLIP)), end = clamp(saved.trim.end, start + MIN_CLIP, Math.min(duration, start + MAX_CLIP));
    setRestored(rev);
    change("restore", () => ({ ...saved, trim: { start, end }, hook: { ...HOOK_DEFAULT, ...saved.hook } }));
  }, [change, duration]);

  // Keyboard: space plays, I/O set the start/end at the playhead, 1-4 pick a step, ctrl+z / ctrl+shift+z undo and redo.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof Element && ev.target.closest("input,textarea,select")) return;
      if (ev.key === " ") { ev.preventDefault(); toggle(); }
      else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      else if (ev.key.toLowerCase() === "i" && video.current) setTrim("start", video.current.currentTime);
      else if (ev.key.toLowerCase() === "o" && video.current) setTrim("end", video.current.currentTime);
      else if (/^[1-4]$/.test(ev.key)) setStep(STEPS[Number(ev.key) - 1].id);
      else if (ev.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undo, redo, setTrim, close]);

  const makeCopy = async () => {
    setCopying(true); setError("");
    try {
      const response = await fetch("/api/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "duplicateClip", id: clipId }) });
      const body = await readJson<{ clipId?: string; message?: string; error?: string }>(response).catch((e: Error) => ({ error: e.message }) as { clipId?: string; message?: string; error?: string });
      if (!response.ok || !body.clipId) throw new Error(body.error || "Couldn't copy the clip. Please retry.");
      onCopied?.(body.clipId, body.message ?? "Copied the clip.");
    } catch (e) { setError((e as Error).message); } finally { setCopying(false); }
  };
  const save = async () => {
    if (!edit || !bundle) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/clips/" + clipId + "/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edit, rev: bundle.rev, ...(saveStyle && { saveStyle: "streamer" }) }) });
      const result = await readJson<{ error?: string; message: string }>(response);
      if (!response.ok) throw new Error(result.error);
      onSaved(result.message);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the edit."); }
    finally { setSaving(false); }
  };

  if (!bundle || !edit) return <div className="editor-shell"><div className="editor-loading">{error ? <><p className="error" role="alert">{error}</p><button className="secondary" onClick={onClose}><ArrowLeft size={16} />Back to clips</button></> : <><Loader2 className="spin" size={22} />Opening the editor…</>}</div></div>;

  const bg = backgroundChoice(edit, backgrounds, bgClips), finished = tl?.length ?? edit.trim.end - edit.trim.start;
  const placing = step === "text" && panel === "title";
  return <div className="editor-shell" role="dialog" aria-label="Clip editor">
    <header className="editor-top">
      <button className="secondary" onClick={close}><ArrowLeft size={16} />Clips</button>
      <div className="editor-title"><strong>{bundle.streamer ?? "Clip"}</strong><small>{new Date(bundle.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {finished.toFixed(1)}s</small></div>
      <div className="editor-actions">
        <button className="icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
        <button className="icon-button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button>
        <button className="icon-button" aria-label="Discard changes" title="Discard changes" disabled={!dirty} onClick={() => { if (!opened) return; setPast(p => [...p, edit]); setFuture([]); setEditState(JSON.parse(opened)); setRestored(null); }}><RotateCcw size={16} /></button>
        {dirty && !saving && <span className="unsaved-dot" title="Changes not saved yet">{restored !== null ? "Older version" : "Unsaved"}</span>}
        <button className="primary" disabled={saving || !!bundle.pruned || (!dirty && !saveStyle)} title={bundle.pruned ? "This clip's editable copy was removed to save storage" : !dirty && !saveStyle ? "Nothing to save yet" : "Save and re-render the clip"} onClick={() => void save()}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}Save &amp; render</button>
      </div>
    </header>
    <nav className="step-bar" aria-label="Editor steps">{STEPS.map((s, i) => <button key={s.id} type="button" className={step === s.id ? "active" : ""} aria-current={step === s.id ? "step" : undefined} onClick={() => setStep(s.id)}><span className="step-n">{i + 1}</span>{s.label}</button>)}</nav>
    {error && <div className="error editor-error" role="alert">{error}</div>}
    {!bundle.sourceStored && <div className="notice editor-error"><p>{bundle.pruned ? "This clip's editable copy was removed on " + bundle.pruned + " to save storage, so it can't be re-edited. The finished clip still posts." : "The editable source isn't in clip storage yet, so the preview can't play."}</p></div>}
    <div className="editor-body">
      <Stage bundle={bundle} edit={edit} editRef={editRef} change={change} video={video} cues={cueList} chat={chatList} tl={tl} placing={placing} bgPreview={bg.preview} bgIsImage={bg.previewIsImage} hasBackgrounds={backgrounds.length > 0} onTime={setTime} />
      <section className="editor-panel">
        <div className="editor-controls">
          {step === "cut" && <CutFrame bundle={bundle} edit={edit} tools={tools} video={video} time={time} setTrim={setTrim} backgrounds={backgrounds} bgClips={bgClips} />}
          {step === "text" && <Text bundle={bundle} edit={edit} tools={tools} words={words} time={time} seek={seek} tl={tl} panel={panel} setPanel={setPanel} video={video} />}
          {step === "extras" && <Extras bundle={bundle} edit={edit} tools={tools} words={words} tl={tl} />}
          {step === "review" && <Review bundle={bundle} dirty={dirty} onRestore={restore} saveStyle={saveStyle} setSaveStyle={setSaveStyle} onCopy={onCopied ? () => void makeCopy() : undefined} copying={copying} />}
        </div>
      </section>
    </div>
    <Timeline bundle={bundle} edit={edit} change={change} setTrim={setTrim} seek={seek} time={time} cues={cueList} words={words} cuts={tl?.cuts ?? []} />
  </div>;
}
