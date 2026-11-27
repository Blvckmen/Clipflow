"use client";
// The "Edit streamer" dialog's body: name, channel URL, whether it is clipped, what happens to its new clips, and
// which accounts post them, and whether its clips get transcription, subtitles and an automatic hook.
import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { captureModes, publishModes } from "../lib/clipflow";
import { DEFAULT_CREDIT, applyRules, parseBrief, readRules } from "../lib/posting-rules.mjs";
import { StreamerViewerClips, type ViewerClipsOwn, type ViewerClipsWs } from "./viewer-clips";

type Rules = { credit: boolean; creditText: string; label: string; hashtags: string[]; mentions: string[]; minSeconds: number | null; maxSeconds: number | null; brief: string };
type Streamer = { id: string; name: string; url: string; status: string; accounts: string[]; capture_mode?: string; publish_mode?: string | null; clip_text?: string | null; posting_rules?: unknown; platform?: string; viewer_clips?: ViewerClipsOwn; daily_limit?: number | null };
export type StreamerChanges = { name: string; url: string; status: string; accounts: string[]; captureMode: string; publishMode: string; clipText: ClipText; postingRules: Rules; viewerClips?: ViewerClipsOwn; dailyLimit: number | null };
export type ClipText = { transcribe?: boolean; subtitles?: boolean; hook?: boolean };
type Choice = "workspace" | "on" | "off";
const TEXT_KEYS = ["transcribe", "subtitles", "hook"] as const;
const readText = (json?: string | null): ClipText => { try { const v = json ? JSON.parse(json) : null; return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const choiceOf = (v?: boolean): Choice => v === undefined ? "workspace" : v ? "on" : "off";

// Transcription, subtitles and the automatic hook for one streamer's new clips: on, off, or the workspace's setting.
// Each is independent: subtitles and hooks transcribe the clip themselves when transcription is off (worker/core.mjs).
function ClipTextFields({ value, onChange, ws }: { value: Record<(typeof TEXT_KEYS)[number], Choice>; onChange: (v: Record<(typeof TEXT_KEYS)[number], Choice>) => void; ws: { transcribe: boolean; subtitles: boolean; hooks?: boolean } }) {
  const wsValue = { transcribe: ws.transcribe, subtitles: ws.subtitles, hook: ws.hooks !== false };
  const on = (k: (typeof TEXT_KEYS)[number]) => value[k] === "workspace" ? wsValue[k] : value[k] === "on";
  const stillTranscribed = !on("transcribe") && (on("subtitles") || on("hook"));
  const rows = [
    ["transcribe", "Transcription", "Whisper on your worker PC writes down what is said, for cuts on full sentences and automatic post text."],
    ["subtitles", "Subtitles", "Word-by-word subtitles on the video."],
    ["hook", "Automatic opening title", "A short title at the start of each clip, written from what is said. You can still type or change one in the editor."],
  ] as const;
  return <fieldset className="clip-text-fields"><legend>Text on new clips <small>Each one turns on or off by itself.</small></legend>
    {rows.map(([k, label, note]) => <label key={k}>{label}
      <select value={value[k]} onChange={e => onChange({ ...value, [k]: e.target.value as Choice })}>
        <option value="workspace">Workspace setting ({wsValue[k] ? "on" : "off"})</option><option value="on">On</option><option value="off">Off</option>
      </select><small>{k === "transcribe" && stillTranscribed ? "Off, but subtitles or the opening title still transcribe each clip because they need what is said." : note}</small></label>)}
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
  const sample = applyRules("Your clip's post text…", value, { streamer: streamer.name, platform: streamer.platform ?? "Twitch", channel });
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
      <label>Required hashtags<input data-emoji="off" value={tagText(value.hashtags)} onChange={e => set({ hashtags: tagList(e.target.value) })} placeholder="#kaicenat #clips" /></label>
      <label>Required mentions<input data-emoji="off" value={tagText(value.mentions)} onChange={e => set({ mentions: tagList(e.target.value) })} placeholder="@kaicenat" /></label>
      <label>Shortest clip (s)<input inputMode="numeric" value={value.minSeconds ?? ""} onChange={e => set({ minSeconds: seconds(e.target.value) })} placeholder="any" /></label>
      <label>Longest clip (s)<input inputMode="numeric" value={value.maxSeconds ?? ""} onChange={e => set({ maxSeconds: seconds(e.target.value) })} placeholder="any" /></label>
    </div>
    <small className="field-note">The label goes first and the credit, hashtags and mentions are added to whatever post text a post has. A clip outside the lengths is held for you instead of posting; queue it yourself to post it anyway.</small>
    <pre className="posting-preview" aria-label="Example post text">{sample}</pre>
  </fieldset>;
}

// "Review clips first / Post to social media directly / workspace setting" for one streamer. `ws` is the
// workspace's current publishing mode (Settings), which "workspace" follows.
export function PublishModeField({ value, onChange, ws }: { value: string; onChange: (v: string) => void; ws: string }) {
  const note = value === "review" ? "New clips wait in Clips → Library → Needs review until you accept them."
    : value === "automatic" ? "New clips are accepted straight away and post to this streamer's accounts."
    : "Follows Settings → Publishing mode (now: " + (ws === "review" ? "review first" : "post directly") + ").";
  return <label>New clips<select value={value} onChange={e => onChange(e.target.value)}>{Object.entries(publishModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    <small>{note}</small></label>;
}

export function StreamerForm({ streamer, hasAccounts, busy, workspaceMode, workspaceText, workspaceViewer, workspaceLimit, picker, onSave }: {
  streamer: Streamer; hasAccounts: boolean; busy: boolean; workspaceMode: string; workspaceText: { transcribe: boolean; subtitles: boolean; hooks?: boolean }; workspaceViewer: { importClips: number } & ViewerClipsWs; workspaceLimit: number;
  picker: (value: string[], onChange: (next: string[]) => void) => ReactNode; onSave: (changes: StreamerChanges) => void;
}) {
  const [name, setName] = useState(streamer.name), [url, setUrl] = useState(streamer.url), [status, setStatus] = useState(streamer.status), [accounts, setAccounts] = useState(streamer.accounts), [mode, setMode] = useState(streamer.capture_mode ?? "clip"), [publish, setPublish] = useState(streamer.publish_mode ?? "workspace");
  const [text, setText] = useState(() => { const t = readText(streamer.clip_text); return { transcribe: choiceOf(t.transcribe), subtitles: choiceOf(t.subtitles), hook: choiceOf(t.hook) }; });
  const clipText = Object.fromEntries(TEXT_KEYS.filter(k => text[k] !== "workspace").map(k => [k, text[k] === "on"])) as ClipText;
  const [rules, setRules] = useState<Rules>(() => readRules(streamer.posting_rules));
  const [viewer, setViewer] = useState<ViewerClipsOwn>(() => streamer.viewer_clips ?? {});
  // Empty follows Settings → Daily limit.
  const [limit, setLimit] = useState<number | null>(streamer.daily_limit ?? null);
  const twitch = /^https:\/\/(www\.)?twitch\.tv\//i.test(url.trim());
  const moved = url.trim() !== streamer.url;
  return <form className="form-body" onSubmit={e => { e.preventDefault(); onSave({ name: name.trim(), url: url.trim(), status, accounts, captureMode: mode, publishMode: publish, clipText, postingRules: rules, dailyLimit: limit, ...(twitch && { viewerClips: viewer }) }); }}>
    <label>Display name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Channel URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.twitch.tv/channel" />
      <small>{moved ? "Changing it follows a different channel from the next check. Clips already captured stay with this streamer." : "Twitch, YouTube, Kick or TikTok LIVE."}</small></label>
    <label>Clipping<select value={status} onChange={e => setStatus(e.target.value)}>
      <option value="armed">Enabled: clip whenever they are live</option>
      <option value="paused">Paused: no recording; clips already caught wait until you enable it</option>
      <option value="stopped">Stopped: no recording; clips already caught are still made</option>
    </select></label>
    <label>When they go live<select value={mode} onChange={e => setMode(e.target.value)}>{Object.entries(captureModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small>{mode === "clip" ? "Clips are cut while they stream." : mode === "record" ? "The whole stream is saved on your worker PC (about 1 to 3 GB an hour) and clipped when it ends. Pick your own clips under Channels → Recordings." : "Clips are cut while they stream, and the whole stream is saved so you can pick more later."}{mode !== (streamer.capture_mode ?? "clip") ? " Applies from their next stream." : ""}</small></label>
    <label>Daily clip limit<input type="number" min={1} max={100} placeholder={"Workspace setting (" + workspaceLimit + ")"} value={limit ?? ""} onChange={e => setLimit(e.target.value === "" ? null : Math.max(1, Math.min(100, Math.round(Number(e.target.value)))))} />
      <small>Most clips a day from this streamer (resets at midnight UTC). Leave empty to use Settings → Daily limit. Viewers&apos; Twitch clips have their own limit.</small></label>
    <PublishModeField value={publish} onChange={setPublish} ws={workspaceMode} />
    <ClipTextFields value={text} onChange={setText} ws={workspaceText} />
    {twitch && <StreamerViewerClips value={viewer} onChange={setViewer} ws={workspaceViewer} />}
    <PostingRulesFields value={rules} onChange={setRules} streamer={{ name: name.trim() || streamer.name, url: url.trim() || streamer.url, platform: streamer.platform }} />
    {hasAccounts && <div><span className="field-label">Post clips to</span>{picker(accounts, setAccounts)}<small className="field-note">Leave all unticked to keep this streamer&apos;s clips in your library only.</small></div>}
    <button className="primary" type="submit" disabled={busy || !name.trim() || !url.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save changes</button>
  </form>;
}
