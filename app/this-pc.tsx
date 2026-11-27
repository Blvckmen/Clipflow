"use client";
import { useEffect, useRef } from "react";
import { AlertTriangle, Check, Cpu, Info, Loader2, MonitorSmartphone, Play, RotateCw, Settings2, Square, XCircle } from "lucide-react";
import { pcProblems } from "../lib/pc-health.mjs";
import type { WorkerSettings } from "../lib/clipflow";

// Settings → This PC: how the worker on the user's own PC runs, chosen here instead of in its .env file, plus what it
// is doing right now. The worker reports back the settings it runs with (app/api/worker/status `device`), so a change
// reads Saved → Waiting for device → Applied, all without a restart. A choice left on "Automatic" follows the PC's
// own setup (its .env, else the default), and the label says what that is on this PC.
export type Device = {
  applied: string | null; recording: string[]; making: number; waiting: number; held: number;
  uses: { maxCaptures: number; clipWorkers: number; whisperModel: string; aiWriter: boolean; retentionHours: number };
  cores: number; memoryGb: number;
  oldestWaitMin?: number; restartPending?: boolean; stopped?: boolean;
  health?: { checkedAt: string; diskFreeGb: number | null; diskTotalGb: number | null; ffmpeg: boolean; streamlink: boolean; whisper: boolean; whisperModel: string; whisperReady: boolean | null; ollama: "off" | "down" | "ok"; ollamaMissing: string[]; codeChanged: boolean } | null;
};
export type PcEngine = { connected: boolean; lastSeen: string | null; tokenCreated: string | null; lastError: string | null; lastErrorAt: string | null; device?: Device | null; deviceAt?: string | null; settingsRev?: string; restartAt?: string | null; restartNow?: boolean; power?: "running" | "stopped" };

const POWER = { light: "Light", balanced: "Balanced", maximum: "Maximum" } as const;
const POWER_OF: Record<number, keyof typeof POWER> = { 1: "light", 2: "balanced", 3: "maximum" };
const QUALITY = { fast: "Faster", balanced: "Balanced", accurate: "More accurate" } as const;
const QUALITY_OF: Record<string, keyof typeof QUALITY> = { base: "fast", small: "balanced", medium: "accurate" };
const ago = (iso: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

/** Channels this PC can record at once without struggling: about one per 4 cores and 6 GB of memory, 1 to 4. */
export function recommendedChannels(cores: number, memoryGb: number) {
  return Math.max(1, Math.min(4, Math.floor(cores / 4), Math.floor(memoryGb / 6)));
}

/** Saved → Waiting for device → Applied, for the saved settings (not unsaved edits). */
export function applyState(engine: PcEngine | null | undefined): "applied" | "waiting" | "offline" | "unknown" {
  if (!engine?.tokenCreated) return "unknown";
  if (engine.device && engine.settingsRev && engine.device.applied === engine.settingsRev) return "applied";
  return engine.connected ? "waiting" : "offline";
}

export function ThisPcSettings({ value, onChange, engine, dirty, channelName, onRefresh, onRestart, onPower, busy }: {
  value: WorkerSettings; onChange: (v: WorkerSettings) => void; engine: PcEngine | null | undefined; dirty: boolean;
  channelName: (id: string) => string | null; onRefresh: () => void; onRestart: (now?: boolean) => void; onPower: (stop: boolean) => void; busy: boolean;
}) {
  const set = <K extends keyof WorkerSettings>(k: K, v: WorkerSettings[K] | undefined) => { const next = { ...value }; if (v === undefined) delete next[k]; else next[k] = v; onChange(next); };
  const device = engine?.device ?? null, uses = device?.uses, state = applyState(engine);
  // While a saved change waits for the PC, look more often than the dashboard's usual 45 seconds.
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => { if (dirty || state !== "waiting") return; const t = setInterval(() => refresh.current(), 10_000); return () => clearInterval(t); }, [dirty, state]);
  const recommended = device ? recommendedChannels(device.cores, device.memoryGb) : null;
  const auto = (text: string | null) => "Automatic" + (text ? " (this PC: " + text + ")" : "");
  const onOff = (k: "autoHooks" | "aiWriter", current?: boolean) => <select value={value[k] === undefined ? "" : value[k] ? "on" : "off"} onChange={e => set(k, e.target.value === "" ? undefined : e.target.value === "on")}><option value="">{current === undefined ? "Automatic (on unless changed)" : auto(current ? "on" : "off")}</option><option value="on">On</option><option value="off">Off</option></select>;
  const recentProblem = engine?.lastError && engine.lastErrorAt && Date.now() - Date.parse(engine.lastErrorAt) < 24 * 3600_000;
  const names = (device?.recording ?? []).map(id => channelName(id) ?? "a removed channel");
  // Health checks (lib/pc-health.mjs): what's wrong on the PC and how to fix it, worst first.
  const problems = pcProblems(device, { connected: !!engine?.connected });
  const checked = !!device?.health && !!engine?.connected;
  // A restart was asked for but the PC hasn't said it's waiting yet (it hears within a minute).
  const restartAsked = !!engine?.restartAt && !device?.restartPending && Date.now() - Date.parse(engine.restartAt) < 3 * 60_000;
  const stopped = engine?.power === "stopped";

  return <section className="panel settings-group this-pc">
    <div className="group-head"><Settings2 size={18} /><div><h2>This PC</h2><p>How the PC that records and makes your clips runs. Changes reach it within a minute, without a restart, and never cut off a recording or a clip in progress.</p></div>
      <span className={"apply-chip " + (dirty ? "dirty" : state)} role="status">{dirty ? "Not saved yet" : state === "applied" ? <><Check size={13} />Applied</> : state === "waiting" ? <><Loader2 size={13} className="spin" />Saved · waiting for this PC</> : state === "offline" ? "Saved · applies when this PC is back online" : "Saved"}</span>
    </div>

    <div className="pc-status">
      <div className={"pc-line " + (engine?.connected ? "ok" : engine?.tokenCreated ? "bad" : "")}>
        <MonitorSmartphone size={16} />
        <div><strong>{engine?.connected ? "Connected" : engine?.lastSeen ? "Offline" : engine?.tokenCreated ? "Waiting for the worker to start" : "Not set up"}</strong>
          <small>{engine?.connected ? "Checked in " + ago(engine.lastSeen!) : engine?.lastSeen ? "Last seen " + ago(engine.lastSeen) + ". Check that the PC is on and the worker is running." : engine?.tokenCreated ? "Start the worker on your PC to begin." : "Connect a PC under Setup & help."}{device ? " · " + plural(device.cores, "core") + ", " + device.memoryGb + " GB memory" : ""}</small></div>
      </div>
      <div className="pc-line">
        <Cpu size={16} />
        <div><strong>{!device ? "Activity not reported yet" : names.length || device.making || device.waiting ? [names.length ? "Recording " + names.join(", ") : "", device.making ? "making " + plural(device.making, "clip") : "", device.waiting ? plural(device.waiting, "clip") + " waiting" : ""].filter(Boolean).join(" · ").replace(/^./, c => c.toUpperCase()) : "Idle: no channel is live"}</strong>
          <small>{!device ? "Shows once the worker is updated and checks in." : device.held ? plural(device.held, "clip") + " held while automation is paused. " : ""}{device && engine?.deviceAt ? "Updated " + ago(engine.deviceAt) + "." : ""}</small></div>
      </div>
      <div className={"pc-line " + (problems.some(p => p.level === "bad") ? "bad" : recentProblem || problems.some(p => p.level === "warn") ? "warn" : "ok")}>
        {problems.length || recentProblem ? <AlertTriangle size={16} /> : <Check size={16} />}
        <div><strong>{problems.length ? plural(problems.length, "thing") + " to look at" : checked ? "All checks passed" : recentProblem ? "Last problem " + ago(engine!.lastErrorAt!) : "No problems in the last day"}</strong>
          {checked && device!.health!.diskFreeGb !== null && <small>{device!.health!.diskFreeGb} GB free on disk · checked {ago(device!.health!.checkedAt)}</small>}
          {recentProblem && <small className="pc-error">Last error {ago(engine!.lastErrorAt!)}: {engine!.lastError}</small>}</div>
      </div>
    </div>

    {problems.length > 0 && <ul className="pc-problems">{problems.map(p => <li key={p.id} className={p.level}>
      {p.level === "bad" ? <XCircle size={16} /> : p.level === "warn" ? <AlertTriangle size={16} /> : <Info size={16} />}
      <div><strong>{p.title}</strong><small>{p.fix}</small></div>
      {p.action === "restart" && <button type="button" className="secondary" disabled={busy || restartAsked} onClick={() => onRestart(false)}><RotateCw size={14} />{restartAsked ? "Restart asked for" : "Restart when idle"}</button>}
    </li>)}</ul>}
    {/* Stop / Start / Restart the worker from here. It acts within a minute, as it checks in; it can't start a PC
        that's off or a worker that isn't running. */}
    {engine?.tokenCreated && <div className="pc-controls">
      {stopped
        ? <button type="button" className="primary" disabled={busy} onClick={() => onPower(false)}><Play size={14} />Start</button>
        : <button type="button" className="secondary" disabled={busy || !engine.connected} onClick={() => { if (window.confirm("Stop this PC? It ends its recordings and stops making clips until you press Start. Clips cut off now pick up again then.")) onPower(true); }}><Square size={14} />Stop</button>}
      {!problems.some(p => p.action === "restart") && <button type="button" className="secondary" disabled={busy || restartAsked || !engine.connected} onClick={() => onRestart(false)}><RotateCw size={14} />{restartAsked && !engine.restartNow ? "Restart asked for" : "Restart when idle"}</button>}
      <button type="button" className="text-button" disabled={busy || restartAsked || !engine.connected} onClick={() => { if (window.confirm("Restart this PC's worker now? Recordings stop for about a minute; clips being made pick up again after it.")) onRestart(true); }}>{restartAsked && engine.restartNow ? "Restarting…" : "Restart now"}</button>
      <small>{stopped ? (device?.stopped ? "Stopped: not recording or making clips. Press Start to carry on." : "Stopping… the PC hears within a minute.") : restartAsked && !engine.restartNow ? "Restarts once nothing is recording or being made." : "These reach the PC within a minute. A PC that's off, or a worker that isn't running, has to be started on the PC itself."}</small>
    </div>}

    <div className="group-body">
      <label>Computer usage<select value={value.power ?? ""} onChange={e => set("power", (e.target.value || undefined) as WorkerSettings["power"])}><option value="">{auto(uses ? POWER[POWER_OF[uses.clipWorkers]] ?? uses.clipWorkers + " clips at a time" : null)}</option><option value="light">Light: one clip at a time</option><option value="balanced">Balanced: two clips at a time</option><option value="maximum">Maximum: three clips at a time</option></select>
        <small>More at once makes clips sooner but keeps the PC busier. Light suits laptops and PCs you also play on. Lowering it lets clips already being made finish.</small></label>
      <label>Transcription quality<select value={value.transcription ?? ""} onChange={e => set("transcription", (e.target.value || undefined) as WorkerSettings["transcription"])}><option value="">{auto(uses ? QUALITY[QUALITY_OF[uses.whisperModel]] ?? uses.whisperModel : null)}</option><option value="fast">Faster: rougher subtitles</option><option value="balanced">Balanced</option><option value="accurate">More accurate: about 3× slower</option></select>
        <small>How carefully speech is turned into subtitles and the transcript the AI reads. More accurate catches names and slang better but takes longer per clip, and downloads about 1.5 GB the first time.</small></label>
      <label>Speech language<select value={value.language ?? ""} onChange={e => set("language", (e.target.value || undefined) as WorkerSettings["language"])}><option value="">Automatic: detect it for each clip</option><option value="en">English</option></select>
        <small>Choose English if your channels speak English. Automatic can guess wrong on loud music or game sound and give garbled subtitles.</small></label>
      <label>Simultaneous channels<select value={value.maxCaptures ?? ""} onChange={e => set("maxCaptures", e.target.value ? Number(e.target.value) : undefined)}><option value="">{auto(uses ? String(uses.maxCaptures) : null)}</option>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}{recommended !== null ? n === recommended ? " (recommended for this PC)" : n > recommended ? " (may slow this PC)" : "" : ""}</option>)}</select>
        <small>How many live channels are recorded at the same time. Others wait, in the order of your Channels list. Lowering it never cuts a recording off: the extra ones finish first.{recommended !== null ? " Recommended here: " + recommended + ", from this PC's " + device!.cores + " cores and " + device!.memoryGb + " GB." : ""}</small></label>
      <label>Clip pickiness<select value={value.pickiness ?? ""} onChange={e => set("pickiness", (e.target.value || undefined) as WorkerSettings["pickiness"])}><option value="">Automatic (Normal unless changed)</option><option value="relaxed">Relaxed: keep more moments</option><option value="normal">Normal</option><option value="strict">Strict: only the best moments</option></select><small>For quiet stretches the AI checks between chat spikes. Strict keeps fewer and saves more of the daily limit for chat spikes. Chat spikes, !clip and viewers&apos; clips are always kept.</small></label>
      <label>Chat sensitivity<select value={value.chatSensitivity ?? ""} onChange={e => set("chatSensitivity", (e.target.value || undefined) as WorkerSettings["chatSensitivity"])}><option value="">Automatic (Normal unless changed)</option><option value="low">Low: only big chat spikes</option><option value="normal">Normal</option><option value="high">High: smaller spikes count too</option></select><small>How far above a channel&apos;s usual chat speed counts as a moment worth clipping.</small></label>
      <label>Opening titles on new clips{onOff("autoHooks")}<small>A short title over the first seconds of each clip. Each channel can turn it off for its own clips.</small></label>
      <label>Local AI writer{onOff("aiWriter", uses?.aiWriter)}<small>Writes opening titles and post text on this PC with Ollama. Off uses the transcript alone.</small></label>
      <label>Keep clip files on this PC for<select value={value.retentionHours ?? ""} onChange={e => set("retentionHours", e.target.value ? Number(e.target.value) : undefined)}><option value="">{auto(uses ? (uses.retentionHours % 24 ? uses.retentionHours + " hours" : plural(uses.retentionHours / 24, "day")) : "3 days unless changed")}</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option><option value="336">14 days</option><option value="720">30 days</option></select><small>Only the PC&apos;s own copies. Clips uploaded to the dashboard stay there.</small></label>
    </div>
  </section>;
}
