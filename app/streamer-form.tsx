"use client";
// The "Edit streamer" dialog's body: name, channel URL, whether it is clipped, what happens to its new clips, and
// which accounts post them, and whether its clips get transcription, subtitles and an automatic hook.
import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { captureModes, publishModes } from "../lib/clipflow";
import { DEFAULT_CREDIT, applyRules, parseBrief, readRules } from "../lib/posting-rules.mjs";

type Rules = { credit: boolean; creditText: string; label: string; hashtags: string[]; mentions: string[]; minSeconds: number | null; maxSeconds: number | null; brief: string };
type Streamer = { id: string; name: string; url: string; status: string; accounts: string[]; capture_mode?: string; publish_mode?: string | null; clip_text?: string | null; posting_rules?: unknown; platform?: string };
export type StreamerChanges = { name: string; url: string; status: string; accounts: string[]; captureMode: string; publishMode: string; clipText: ClipText; postingRules: Rules };
export type ClipText = { transcribe?: boolean; subtitles?: boolean; hook?: boolean };
type Choice = "workspace" | "on" | "off";
const TEXT_KEYS = ["transcribe", "subtitles", "hook"] as const;
const readText = (json?: string | null): ClipText => { try { const v = json ? JSON.parse(json) : null; return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const choiceOf = (v?: boolean): Choice => v === undefined ? "workspace" : v ? "on" : "off";

// Transcription, subtitles and the automatic hook for one streamer's new clips: on, off, or the workspace's setting.
// Subtitles and hooks are made from the transcript, so they are off while transcription is.
function ClipTextFields({ value, onChange, ws }: { value: Record<(typeof TEXT_KEYS)[number], Choice>; onChange: (v: Record<(typeof TEXT_KEYS)[number], Choice>) => void; ws: { transcribe: boolean; subtitles: boolean } }) {
  const wsValue = { transcribe: ws.transcribe, subtitles: ws.subtitles, hook: true };
  const on = (k: (typeof TEXT_KEYS)[number]) => value[k] === "workspace" ? wsValue[k] : value[k] === "on";
  const noTranscript = !on("transcribe");
  const rows = [
    ["transcribe", "Transcription", "Whisper on your worker PC writes down what is said. Needed for subtitles, hooks and AI post captions."],
    ["subtitles", "Subtitles", "Word-by-word captions on the video."],
    ["hook", "Automatic hook", "A short title at the start of each clip, written from what is said. You can still type or change one in the editor."],
  ] as const;
  return <fieldset className="clip-text-fields"><legend>Text on new clips</legend>
    {rows.map(([k, label, note]) => { const off = k !== "transcribe" && noTranscript; return <label key={k} className={off ? "muted-field" : ""}>{label}
      <select value={value[k]} disabled={off} onChange={e => onChange({ ...value, [k]: e.target.value as Choice })}>
        <option value="workspace">Workspace setting ({k === "hook" ? "on" : wsValue[k] ? "on" : "off"})</option><option value="on">On</option><option value="off">Off</option>
      </select><small>{off ? "Off while transcription is off for this streamer." : note}</small></label>; })}
  </fieldset>;
}

// A credit line for the streamer, and a clipping campaign's rules (paste the brief; what it asks for fills the
// fields, which can be changed), applied to every post of this streamer's clips.
const tagText = (list: string[]) => list.join(" ");
const tagList = (text: string) => text.split(/[\s,]+/).filter(Boolean);
function PostingRulesFields({ value, onChange, streamer }: { value: Rules; onChange: (v: Rules) => void; streamer: { name: string; url: string; platform?: string } }) {
  const [found, setFound] = useState<string | null>(null);
  const set = (patch: Partial<Rules>) => onChange({ ...value, ...patch });
  const seconds = (text: string) => { const n = Number(text); return text.trim() && Number.isInteger(n) && n >= 5 && n <= 600 ? n : null; };
  const channel = (() => { try { const u = new URL(streamer.url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return ""; } })();
  const sample = applyRules("Your clip's caption…", value, { streamer: streamer.name, platform: streamer.platform ?? "Twitch", channel });
  const readBrief = () => {
    const got = parseBrief(value.brief), keys = Object.keys(got);
    onChange({ ...value, ...got, hashtags: got.hashtags ?? value.hashtags, mentions: got.mentions ?? value.mentions });
    setFound(keys.length ? "Filled in from the brief: " + keys.map(k => ({ label: "label", hashtags: "hashtags", mentions: "mentions", minSeconds: "shortest length", maxSeconds: "longest length", credit: "credit" } as Record<string, string>)[k]).join(", ") + ". Check them below." : "Nothing recognisable in it: fill in the fields yourself.");
  };
  return <fieldset className="posting-rules"><legend>Posting rules</legend>
    <label className="switch-row"><input type="checkbox" checked={value.credit} onChange={e => set({ credit: e.target.checked })} /> Credit the streamer in every post</label>
    {value.credit && <label>Credit line<input maxLength={200} value={value.creditText} onChange={e => set({ creditText: e.target.value })} placeholder={DEFAULT_CREDIT} />
      <small>{"{streamer}"}, {"{platform}"} and {"{channel}"} are filled in.</small></label>}
    <label>Clipping campaign brief<textarea rows={4} maxLength={4000} value={value.brief} onChange={e => set({ brief: e.target.value })} placeholder="Paste the campaign's requirements (Discord, Whop, email…)" /></label>
    <div className="row-actions"><button type="button" className="secondary" disabled={!value.brief.trim()} onClick={readBrief}>Read the brief</button>{found && <small className="muted" role="status">{found}</small>}</div>
    <div className="posting-rules-grid">
      <label>Ad label<input maxLength={40} value={value.label} onChange={e => set({ label: e.target.value })} placeholder="#ad" /></label>
      <label>Required hashtags<input value={tagText(value.hashtags)} onChange={e => set({ hashtags: tagList(e.target.value) })} placeholder="#kaicenat #clips" /></label>
      <label>Required mentions<input value={tagText(value.mentions)} onChange={e => set({ mentions: tagList(e.target.value) })} placeholder="@kaicenat" /></label>
      <label>Shortest clip (s)<input inputMode="numeric" value={value.minSeconds ?? ""} onChange={e => set({ minSeconds: seconds(e.target.value) })} placeholder="any" /></label>
      <label>Longest clip (s)<input inputMode="numeric" value={value.maxSeconds ?? ""} onChange={e => set({ maxSeconds: seconds(e.target.value) })} placeholder="any" /></label>
    </div>
    <small className="field-note">The label goes first and the credit, hashtags and mentions are added to whatever caption a post has. A clip outside the lengths is held for you instead of posting; queue it yourself to post it anyway.</small>
    <pre className="posting-preview" aria-label="Example caption">{sample}</pre>
  </fieldset>;
}

// "Review clips first / Post to social media directly / workspace setting" for one streamer. `ws` is the
// workspace's current publishing mode (Settings), which "workspace" follows.
export function PublishModeField({ value, onChange, ws }: { value: string; onChange: (v: string) => void; ws: string }) {
  const note = value === "review" ? "New clips wait in Clip library → Needs review until you accept them."
    : value === "automatic" ? "New clips are accepted straight away and post to this streamer's accounts."
    : "Follows Settings → Publishing mode (now: " + (ws === "review" ? "review first" : "post directly") + ").";
  return <label>New clips<select value={value} onChange={e => onChange(e.target.value)}>{Object.entries(publishModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    <small>{note}</small></label>;
}

export function StreamerForm({ streamer, hasAccounts, busy, workspaceMode, workspaceText, picker, onSave }: {
  streamer: Streamer; hasAccounts: boolean; busy: boolean; workspaceMode: string; workspaceText: { transcribe: boolean; subtitles: boolean };
  picker: (value: string[], onChange: (next: string[]) => void) => ReactNode; onSave: (changes: StreamerChanges) => void;
}) {
  const [name, setName] = useState(streamer.name), [url, setUrl] = useState(streamer.url), [status, setStatus] = useState(streamer.status), [accounts, setAccounts] = useState(streamer.accounts), [mode, setMode] = useState(streamer.capture_mode ?? "clip"), [publish, setPublish] = useState(streamer.publish_mode ?? "workspace");
  const [text, setText] = useState(() => { const t = readText(streamer.clip_text); return { transcribe: choiceOf(t.transcribe), subtitles: choiceOf(t.subtitles), hook: choiceOf(t.hook) }; });
  const clipText = Object.fromEntries(TEXT_KEYS.filter(k => text[k] !== "workspace").map(k => [k, text[k] === "on"])) as ClipText;
  const [rules, setRules] = useState<Rules>(() => readRules(streamer.posting_rules));
  const moved = url.trim() !== streamer.url;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onSave({ name: name.trim(), url: url.trim(), status, accounts, captureMode: mode, publishMode: publish, clipText, postingRules: rules }); }}>
    <label>Display name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Channel URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.twitch.tv/channel" />
      <small>{moved ? "Changing it follows a different channel from the next check. Clips already captured stay with this streamer." : "Twitch, YouTube, Kick or TikTok LIVE."}</small></label>
    <label>Clipping<select value={status} onChange={e => setStatus(e.target.value)}>
      <option value="armed">Enabled: clip whenever they are live</option>
      <option value="paused">Paused</option>
      <option value="stopped">Stopped</option>
    </select></label>
    <label>When they go live<select value={mode} onChange={e => setMode(e.target.value)}>{Object.entries(captureModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>{mode === "clip" ? "Clips are cut while they stream." : mode === "record" ? "The whole stream is saved on your worker PC (about 1 to 3 GB an hour) and clipped when it ends. Pick your own clips under Recordings." : "Clips are cut while they stream, and the whole stream is saved so you can pick more later."}{mode !== (streamer.capture_mode ?? "clip") ? " Applies from their next stream." : ""}</small></label>
    <PublishModeField value={publish} onChange={setPublish} ws={workspaceMode} />
    <ClipTextFields value={text} onChange={setText} ws={workspaceText} />
    <PostingRulesFields value={rules} onChange={setRules} streamer={{ name: name.trim() || streamer.name, url: url.trim() || streamer.url, platform: streamer.platform }} />
    {hasAccounts && <div><span className="field-label">Post clips to</span>{picker(accounts, setAccounts)}<small className="field-note">Leave all unticked to keep this streamer&apos;s clips in your library only.</small></div>}
    <button className="primary" type="submit" disabled={busy || !name.trim() || !url.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save changes</button>
  </form>;
}
