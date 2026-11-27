"use client";
// Step 2, Text: an on/off bar for the subtitles and the opening title, and a panel for each of them and for the
// transcript they are made from.
import { useState, type RefObject } from "react";
import { Download, Sparkles } from "lucide-react";
import { ALIGNS, ANIMATIONS, FONTS, HOOK_ANIMS, HOOK_DEFAULT, HOOK_LINES, HOOK_SIZE, HOOK_X, HOOK_Y, PRESETS, SHADOW_MAX, hookLines } from "../../../worker/edit.mjs";
import { suggestHooks } from "../../../worker/hooks.mjs";
import { countMatches, normalizeSpeakers, replaceWords, shiftWords, speakerAt, subtitleFile } from "../../../worker/transcript.mjs";
import { More } from "../More";
import { setMedia, type Bundle, type ClipTimeline, type Edit, type Speaker, type Tools, type Word } from "../types";

export type TextPanel = "subtitles" | "title" | "transcript";
const animationLabels: Record<string, string> = { none: "Static", pop: "Pop in", karaoke: "Karaoke", word: "One word at a time" };
const alignLabels: Record<string, string> = { left: "Left", center: "Centre", right: "Right" };
const hookAnimLabels: Record<string, string> = { pop: "Pop in", fade: "Fade in and out", none: "None" };
type Timeline = ClipTimeline;

export function Text({ bundle, edit, tools, words, time, seek, tl, panel, setPanel, video }: {
  bundle: Bundle; edit: Edit; tools: Tools; words: Word[]; time: number; seek: (t: number) => void; tl: Timeline | null;
  panel: TextPanel; setPanel: (p: TextPanel) => void; video: RefObject<HTMLVideoElement | null>;
}) {
  const c = edit.captions, titleOn = edit.hook.on !== false;
  return <>
    <div className="text-switches" role="tablist">
      <Chip id="subtitles" label="Subtitles" lane="l-sub" on={c.on} panel={panel} setPanel={setPanel} onToggle={bundle.legacy ? undefined : v => tools.setCaption({ on: v, preset: c.preset })} />
      <Chip id="title" label="Opening title" lane="l-title" on={titleOn && !!edit.hook.text} panel={panel} setPanel={setPanel} onToggle={v => tools.set("hook", { on: v })} />
      <Chip id="transcript" label="Transcript" lane="l-words" panel={panel} setPanel={setPanel} />
    </div>
    {bundle.legacy && panel !== "title" && <p className="hint">This clip&apos;s subtitles are part of the picture, so they can&apos;t be changed here.</p>}
    {panel === "subtitles" && !bundle.legacy && <Subtitles edit={edit} tools={tools} />}
    {panel === "title" && <Title edit={edit} tools={tools} words={words} video={video} streamer={bundle.streamer} />}
    {panel === "transcript" && !bundle.legacy && <Transcript bundle={bundle} edit={edit} tools={tools} words={words} time={time} seek={seek} tl={tl} />}
  </>;
}

function Chip({ id, label, lane, on, panel, setPanel, onToggle }: { id: TextPanel; label: string; lane: string; on?: boolean; panel: TextPanel; setPanel: (p: TextPanel) => void; onToggle?: (v: boolean) => void }) {
  return <div className={"text-chip " + lane + (panel === id ? " active" : "") + (on === false ? " off" : "")}>
    <button type="button" role="tab" aria-selected={panel === id} onClick={() => setPanel(id)}>{label}</button>
    {onToggle && <label className="chip-switch" title={on ? "Shown: click to hide" : "Hidden: click to show"}><input type="checkbox" checked={!!on} onChange={e => onToggle(e.target.checked)} /><span aria-hidden /></label>}
  </div>;
}

function Subtitles({ edit, tools }: { edit: Edit; tools: Tools }) {
  const c = edit.captions, set = tools.setCaption;
  return <div className={"caption-controls" + (c.on ? "" : " off")}>
    <div className="presets">{Object.entries(PRESETS).map(([key, p]) => <button key={key} className={c.preset === key ? "preset active" : "preset"} onClick={() => { const { label: _label, ...values } = p as typeof p & { label: string }; void _label; set({ ...values, preset: key, on: true }); }} style={{ fontFamily: `"${p.font}", sans-serif`, color: p.color, background: p.box ? p.boxColor : undefined, textShadow: p.box ? "none" : `0 0 3px ${p.outlineColor}, 0 0 3px ${p.outlineColor}` }}>{p.uppercase ? p.label.toUpperCase() : p.label}</button>)}</div>
    <div className="control-grid">
      <label>Font<select value={c.font} onChange={e => set({ font: e.target.value })}>{FONTS.map((f: string) => <option key={f} style={{ fontFamily: f }}>{f}</option>)}</select></label>
      <label>Size <span>{c.size}</span><input type="range" min={24} max={140} value={c.size} onChange={e => set({ size: Number(e.target.value) })} /></label>
      <label>Position <span>{Math.round(c.y * 100)}% down</span><input type="range" min={8} max={95} value={Math.round(c.y * 100)} onChange={e => set({ y: Number(e.target.value) / 100 })} /></label>
      <label>Animation<select value={c.animation} onChange={e => set({ animation: e.target.value })}>{ANIMATIONS.map((a: string) => <option key={a} value={a}>{animationLabels[a]}</option>)}</select></label>
    </div>
    <More>
      <div className="control-grid">
        <label>Words per line <span>{c.words}</span><input type="range" min={1} max={8} value={c.words} onChange={e => set({ words: Number(e.target.value) })} /></label>
        <label>Outline <span>{c.outline}px</span><input type="range" min={0} max={12} value={c.outline} disabled={c.box} onChange={e => set({ outline: Number(e.target.value) })} /></label>
        <label>Shadow <span>{c.shadow ? c.shadow + "px" : "None"}</span><input type="range" min={0} max={SHADOW_MAX} value={c.shadow ?? 0} onChange={e => set({ shadow: Number(e.target.value) })} /></label>
        <label>Line up<select value={c.align ?? "center"} onChange={e => set({ align: e.target.value })}>{ALIGNS.map((a: string) => <option key={a} value={a}>{alignLabels[a]}</option>)}</select></label>
        <label className="color">Text<input type="color" value={c.color} onChange={e => set({ color: e.target.value })} /></label>
        <label className="color">Highlight<input type="color" value={c.highlight} onChange={e => set({ highlight: e.target.value })} /></label>
        <label className="color" title="Each line's most important word">Key words<input type="color" value={c.keywordColor} disabled={!c.keywords} onChange={e => set({ keywordColor: e.target.value })} /></label>
        <label className="color">Outline<input type="color" value={c.outlineColor} onChange={e => set({ outlineColor: e.target.value })} /></label>
        <label className="color">Box<input type="color" value={c.boxColor} onChange={e => set({ boxColor: e.target.value })} /></label>
      </div>
      <div className="toggles">
        <label><input type="checkbox" checked={c.bold !== false} onChange={e => set({ bold: e.target.checked })} /><strong>Bold</strong></label>
        <label><input type="checkbox" checked={!!c.italic} onChange={e => set({ italic: e.target.checked })} /><em>Italic</em></label>
        <label><input type="checkbox" checked={c.box} onChange={e => set({ box: e.target.checked })} />Background box</label>
        <label><input type="checkbox" checked={c.uppercase} onChange={e => set({ uppercase: e.target.checked })} />ALL CAPS</label>
        <label title="A strong word, a number, a name, or one that was shouted"><input type="checkbox" checked={c.keywords} onChange={e => set({ keywords: e.target.checked })} />Highlight key words</label>
        <label title="f***, for brand-friendly accounts"><input type="checkbox" checked={c.mask} onChange={e => set({ mask: e.target.checked })} />Bleep swear words</label>
      </div>
    </More>
  </div>;
}

function Title({ edit, tools, words, video, streamer }: { edit: Edit; tools: Tools; words: Word[]; video: RefObject<HTMLVideoElement | null>; streamer: string | null }) {
  const { set, change } = tools, c = edit.captions, h = edit.hook, len = edit.trim.end - edit.trim.start;
  const [ideas, setIdeas] = useState<{ text: string; source: string }[] | null>(null), [note, setNote] = useState("");
  // Three titles to pick from, from the current unsaved trim and transcript corrections (said lines first).
  const suggest = () => {
    const list = suggestHooks(words, edit.trim, { mask: c.mask, name: streamer ?? "" });
    setIdeas(list); setNote(list.length ? "" : "No usable speech in this trim. Type a title instead.");
  };
  const pick = (text: string) => {
    change("generate-hook", e => ({ ...e, hook: { ...e.hook, text: text.split("\n").slice(0, HOOK_LINES).join("\n"), lines: undefined, on: true } }));
    video.current?.pause(); setMedia(video.current, { currentTime: edit.trim.start });
    setNote("Undo brings the old one back.");
  };
  const lines = hookLines(edit) as { text: string; color: string; size: number }[];
  const setLine = (i: number, value: { color?: string; size?: number } | null) => change("hook-line" + i + (value ? Object.keys(value).join() : ""), e => {
    const own = [...(e.hook.lines ?? [])];
    while (own.length <= i) own.push(null);
    own[i] = value ? { ...(own[i] ?? {}), ...value } : null;
    return { ...e, hook: { ...e.hook, lines: own.some(Boolean) ? own.slice(0, HOOK_LINES) : undefined } };
  });
  const maxLen = Math.max(1, Math.min(30, Math.floor(len))), whole = h.seconds >= len;
  return <>
    <textarea className="hook-text" aria-label="Opening title" rows={Math.min(HOOK_LINES, Math.max(2, h.text.split("\n").length))} maxLength={90} placeholder={"e.g. He did NOT\nsee that coming"} value={h.text}
      onKeyDown={e => { if (e.key === "Enter" && h.text.split("\n").length >= HOOK_LINES) e.preventDefault(); }}
      onChange={e => set("hook", { text: e.target.value.split("\n").slice(0, HOOK_LINES).join("\n") })} />
    <div className="title-actions">
      <button className="secondary" onClick={suggest}><Sparkles size={15} />{ideas ? "More ideas" : "Ideas"}</button>
      {ideas?.map(i => <button key={i.text} type="button" className="idea" title={i.source === "said" ? "Said in this clip" : "A general opener"} onClick={() => pick(i.text)}>{i.text}</button>)}
      {note && <span className="hint" role="status">{note}</span>}
    </div>
    <label>Shows for <span>{whole ? "the whole clip" : h.seconds + "s"}</span><input type="range" min={1} max={maxLen} step={0.5} value={Math.min(h.seconds, maxLen)} disabled={whole} onChange={e => set("hook", { seconds: Number(e.target.value) })} />
      <span className="check-inline"><input type="checkbox" checked={whole} onChange={e => set("hook", { seconds: e.target.checked ? 90 : 5 })} />Whole clip</span></label>
    <p className="hint">Drag it on the preview to move it.</p>
    <More>
      <div className="control-grid">
        <label>Size <span>{h.size}px</span><input type="range" min={HOOK_SIZE[0]} max={HOOK_SIZE[1]} step={2} value={h.size} onChange={e => set("hook", { size: Number(e.target.value) })} /></label>
        <label>Left / right <span>{Math.round(h.x * 100)}%</span><input type="range" min={HOOK_X[0]} max={HOOK_X[1]} step={0.005} value={h.x} onChange={e => set("hook", { x: Number(e.target.value) })} /></label>
        <label>Up / down <span>{Math.round(h.y * 100)}%</span><input type="range" min={HOOK_Y[0]} max={HOOK_Y[1]} step={0.005} value={h.y} onChange={e => set("hook", { y: Number(e.target.value) })} /></label>
        <label>Line up<select value={h.align ?? "center"} onChange={e => set("hook", { align: e.target.value })}>{ALIGNS.map((a: string) => <option key={a} value={a}>{alignLabels[a]}</option>)}</select></label>
        <label>Animation<select value={h.anim ?? "pop"} onChange={e => set("hook", { anim: e.target.value as "pop" | "fade" | "none" })}>{HOOK_ANIMS.map((a: string) => <option key={a} value={a}>{hookAnimLabels[a]}</option>)}</select></label>
        <label className="color">Text<input type="color" value={h.color} onChange={e => set("hook", { color: e.target.value })} /></label>
        <label className="color" title="Off: the text alone, with an outline">Background<div className="color-pair"><input type="checkbox" aria-label="Title background" checked={!!h.bg} onChange={e => set("hook", { bg: e.target.checked ? "#ffffff" : null })} />{h.bg && <input type="color" value={h.bg} onChange={e => set("hook", { bg: e.target.value })} />}</div></label>
      </div>
      <div className="toggles">
        <label><input type="checkbox" checked={!!h.uppercase} onChange={e => set("hook", { uppercase: e.target.checked })} />ALL CAPS</label>
        <label title="Off: the title follows the subtitles' font, bold, italic and shadow"><input type="checkbox" checked={!!h.own} onChange={e => set("hook", e.target.checked ? { own: true, font: h.font ?? c.font, bold: h.bold ?? c.bold !== false, italic: h.italic ?? !!c.italic, shadow: h.shadow ?? c.shadow ?? 0 } : { own: false })} />Own text style</label>
        <button type="button" className="text-button" onClick={() => set("hook", { ...HOOK_DEFAULT })}>Reset size and place</button>
      </div>
      {h.own ? <div className="control-grid">
        <label>Font<select value={h.font ?? c.font} onChange={e => set("hook", { font: e.target.value })}>{FONTS.map((f: string) => <option key={f} style={{ fontFamily: f }}>{f}</option>)}</select></label>
        <label>Shadow <span>{h.shadow ? h.shadow + "px" : "None"}</span><input type="range" min={0} max={SHADOW_MAX} value={h.shadow ?? 0} onChange={e => set("hook", { shadow: Number(e.target.value) })} /></label>
        <span className="toggles">
          <label><input type="checkbox" checked={h.bold !== false} onChange={e => set("hook", { bold: e.target.checked })} /><strong>Bold</strong></label>
          <label><input type="checkbox" checked={!!h.italic} onChange={e => set("hook", { italic: e.target.checked })} /><em>Italic</em></label>
        </span>
      </div> : <p className="hint">Same style as the subtitles ({c.font}).</p>}
      {lines.length > 1 && <div className="title-lines">{lines.map((l, i) => { const own = h.lines?.[i]; return <div key={i} className="title-line">
        <span className="title-line-text" style={{ color: l.color }}>{l.text}</span>
        <input type="color" aria-label={"Line " + (i + 1) + " colour"} value={l.color} onChange={e => setLine(i, { color: e.target.value })} />
        <input type="range" aria-label={"Line " + (i + 1) + " size"} min={HOOK_SIZE[0]} max={HOOK_SIZE[1]} step={2} value={l.size} onChange={e => setLine(i, { size: Number(e.target.value) })} />
        {own && <button type="button" className="text-button" onClick={() => setLine(i, null)}>Reset</button>}
      </div>; })}</div>}
    </More>
  </>;
}

function Transcript({ bundle, edit, tools, words, time, seek, tl }: { bundle: Bundle; edit: Edit; tools: Tools; words: Word[]; time: number; seek: (t: number) => void; tl: Timeline | null }) {
  const { change } = tools, [selected, setSelected] = useState<number | null>(null);
  const [find, setFind] = useState(""), [put, setPut] = useState(""), [who, setWho] = useState(""), [note, setNote] = useState("");
  const found = find.trim() ? countMatches(words, find) : 0, total = bundle.source.duration, speakers: Speaker[] = edit.speakers ?? [];
  const setWords = (key: string, next: Word[]) => change(key, e => ({ ...e, words: next }));
  const editWord = (i: number, text: string) => { const list = words.map(w => [...w] as Word); list[i][2] = text.replace(/[{}\\\r\n]/g, "").slice(0, 40); setWords("word" + i, list); };
  const nudge = (s: number) => { try { setWords("words-shift", shiftWords(words, s) as Word[]); setNote("Subtitles moved " + (s > 0 ? "later" : "earlier") + " by " + Math.abs(s) + "s."); } catch (e) { setNote((e as Error).message); } };
  const download = (format: "srt" | "vtt" | "txt") => {
    const file = subtitleFile(format, edit, words, tl ?? undefined);
    const a = document.createElement("a"), url = URL.createObjectURL(new Blob([file.body], { type: file.type }));
    a.href = url; a.download = (bundle.streamer ?? "clip").replace(/[^\w-]+/g, "_") + "-" + bundle.id.slice(0, 8) + "." + file.ext; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!words.length) return <p className="muted">No speech was transcribed for this clip.</p>;
  return <>
    <p className="hint">Click a word to jump, double-click to fix it.</p>
    <div className="transcript">{words.map((w, i) => {
      const inside = w[0] >= edit.trim.start - 0.05 && w[1] <= edit.trim.end + 0.05, now = time >= w[0] && time < w[1];
      const name = speakers.length ? speakerAt(speakers, w[0]) : "", starts = !!name && (i === 0 || speakerAt(speakers, words[i - 1][0]) !== name);
      return <span key={i} className="word-wrap">{starts && <b className="speaker-tag">{name}</b>}{selected === i
        ? <input autoFocus className="word-input" defaultValue={w[2]} onBlur={e => { if (e.target.value !== w[2]) editWord(i, e.target.value); setSelected(null); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setSelected(null); }} />
        : <button className={"word" + (inside ? "" : " outside") + (now ? " now" : "") + (w[2] ? "" : " hidden")} onClick={() => seek(w[0])} onDoubleClick={() => setSelected(i)}>{w[2] || "(hidden)"}</button>}</span>;
    })}</div>
    <div className="download-row"><Download size={15} /><span>Download</span>{(["srt", "vtt", "txt"] as const).map(f => <button key={f} type="button" className="secondary" onClick={() => download(f)}>{f.toUpperCase()}</button>)}</div>
    <More label="Find, sync and speakers">
      <div className="find-row">
        <input aria-label="Find" placeholder="Find" value={find} onChange={e => setFind(e.target.value)} />
        <input aria-label="Replace with" placeholder="Replace with" value={put} onChange={e => setPut(e.target.value)} />
        <button type="button" className="secondary" disabled={!found} onClick={() => { const r = replaceWords(words, find, put); setWords("words-replace", r.words as Word[]); setNote("Replaced " + r.count + "."); }}>Replace {found || ""}</button>
      </div>
      <div className="find-row">
        <span>Subtitles timing</span>
        <button type="button" className="secondary" onClick={() => nudge(-0.1)}>0.1s earlier</button>
        <button type="button" className="secondary" onClick={() => nudge(0.1)}>0.1s later</button>
      </div>
      <div className="find-row">
        <input aria-label="Speaker name" placeholder="Speaker from the playhead on" maxLength={30} value={who} onChange={e => setWho(e.target.value)} />
        <button type="button" className="secondary" disabled={!who.trim()} onClick={() => { change("speakers", e => ({ ...e, speakers: normalizeSpeakers([...(e.speakers ?? []).filter(s => Math.abs(s.at - time) > 0.05), { at: Math.round(time * 100) / 100, name: who.trim() }], total) })); setWho(""); }}>Add</button>
      </div>
      {speakers.length > 0 && <div className="speaker-list">{speakers.map(s => <span key={s.at} className="source-chip">{s.name} from {Math.max(0, s.at - edit.trim.start).toFixed(1)}s<button type="button" className="text-button" aria-label={"Remove " + s.name} onClick={() => change("speakers", e => ({ ...e, speakers: (e.speakers ?? []).filter(x => x.at !== s.at) }))}>×</button></span>)}</div>}
      {edit.words && <button className="secondary" onClick={() => change("words-reset", e => { const next = { ...e }; delete next.words; return next; })}>Restore the original transcript</button>}
    </More>
    {note && <p className="hint" role="status">{note}</p>}
  </>;
}
