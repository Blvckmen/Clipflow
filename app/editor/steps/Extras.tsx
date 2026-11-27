"use client";
// Step 3, Extras: jump cuts, punch-in zooms, chat on the clip, background music and the progress bar.
import { DEFAULT_CHAT } from "../../../worker/edit.mjs";
import type { Bundle, ClipTimeline, Edit, Pace, Tools, Word } from "../types";

type Timeline = ClipTimeline;
export function Extras({ bundle, edit, tools, words, tl }: { bundle: Bundle; edit: Edit; tools: Tools; words: Word[]; tl: Timeline | null }) {
  const { change, set } = tools, pace = { cuts: "off", zooms: false, ...edit.pace } as Pace, messages = bundle.signals?.messages ?? null;
  const len = edit.trim.end - edit.trim.start, finished = tl?.length ?? len, cutTotal = Math.round((len - finished) * 10) / 10, music = edit.audio?.music ?? "keep";
  return <>
    <label className="wide">Jump cuts <small>Takes quiet pauses out between words.</small>
      <div className="segmented">{(["off", "gentle", "tight"] as const).map(level => <button key={level} type="button" className={pace.cuts === level ? "active" : ""} onClick={() => change("pace-cuts", e => ({ ...e, pace: { ...pace, ...e.pace, cuts: level } }))}>{{ off: "Off", gentle: "Gentle", tight: "Tight" }[level]}</button>)}</div>
      {pace.cuts !== "off" && <small role="status">{bundle.legacy || !words.length ? "No transcript, so no pauses to find." : tl?.cuts.length ? `${tl.cuts.length} pause${tl.cuts.length === 1 ? "" : "s"} out (${cutTotal}s): ${finished.toFixed(1)}s long.` : "No pauses to cut in this trim."}</small>}</label>
    <label className="switch-row"><input type="checkbox" checked={pace.zooms} onChange={e => { const on = e.target.checked; change("pace-zooms", x => ({ ...x, pace: { ...pace, ...x.pace, zooms: on } })); }} />Punch-in zooms <small>{pace.zooms ? (tl?.punches.length ? tl.punches.length + " at " + tl.punches.map(p => p.toFixed(1) + "s").join(", ") : bundle.signals?.energy ? "Nothing loud enough in this trim." : "This clip has no loudness data.") : "On the loudest moments"}</small></label>
    <label className="switch-row"><input type="checkbox" disabled={!messages?.length} checked={!!edit.chat?.on} onChange={e => { const on = e.target.checked; change("chat-on", x => ({ ...x, chat: { ...DEFAULT_CHAT, ...x.chat, on } })); }} />Chat on the clip <small>{messages?.length ? messages.length + " Twitch messages" : "Only live Twitch clips keep their chat."}</small></label>
    {edit.chat?.on && <label>Chat position <span>{Math.round(edit.chat.y * 100)}% down</span><input type="range" min={15} max={95} value={Math.round(edit.chat.y * 100)} onChange={e => { const y = Number(e.target.value) / 100; change("chat-y", x => ({ ...x, chat: { ...DEFAULT_CHAT, ...x.chat, y } })); }} /></label>}
    <label className="wide">Background music <small>Copyrighted music can get a clip muted. The preview plays the original sound.</small>
      <div className="segmented">{([["keep", "As recorded"], ["lower", "Music down"], ["voice", "Voice only"]] as const).map(([mode, label]) => <button key={mode} type="button" className={music === mode ? "active" : ""} onClick={() => change("audio-music", x => ({ ...x, audio: { ...x.audio, music: mode } }))}>{label}</button>)}</div></label>
    <label className="switch-row"><input type="checkbox" checked={edit.progress.on} onChange={e => set("progress", { on: e.target.checked })} />Progress bar</label>
    {edit.progress.on && <label className="color inline">Bar colour<input type="color" value={edit.progress.color} onChange={e => set("progress", { color: e.target.value })} /></label>}
  </>;
}
