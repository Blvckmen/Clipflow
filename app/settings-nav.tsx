"use client";
import { useEffect, useState } from "react";

// Settings in short categories (after the ClipFlow 2.0 Phase 14 design): a menu on the left, the chosen category on
// the right, and who each one applies to. The workspace settings still save together with the bar at the bottom, so
// switching category never loses a change.
export type SettingsTab = "clips" | "moments" | "posting" | "recordings" | "pc" | "plan" | "account" | "device";
export const SETTINGS_TABS: { id: SettingsTab; title: string; desc: string; scope: string }[] = [
  { id: "clips", title: "Clips", desc: "Length, layout and text", scope: "Workspace · every channel, unless a channel sets its own" },
  { id: "moments", title: "Finding moments", desc: "What makes a clip", scope: "Workspace · every channel" },
  { id: "posting", title: "Posting", desc: "Review and post text", scope: "Workspace · every account, unless an account sets its own" },
  { id: "recordings", title: "Recordings", desc: "Streams and highlights", scope: "Workspace" },
  { id: "pc", title: "This PC", desc: "The PC that clips", scope: "The worker PC connected to this workspace" },
  { id: "plan", title: "Plan", desc: "Billing and usage", scope: "Workspace" },
  { id: "account", title: "Account & data", desc: "Sign-in, export, delete", scope: "You and this workspace" },
  { id: "device", title: "This device", desc: "How the app looks here", scope: "Only this browser on this device" },
];

// "This device" preferences: kept in this browser only (no account sync), a strict allowlist, defaults on anything odd.
// Storage can be missing (private windows, blocked site data): then they last until the page is reloaded.
export type DevicePrefs = { reduceMotion: boolean; clipOrder: "new" | "best" };
const KEY = "clipflow.device.v1", DEFAULTS: DevicePrefs = { reduceMotion: false, clipOrder: "new" };
export function readPrefs(raw: unknown): DevicePrefs {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { reduceMotion: typeof v.reduceMotion === "boolean" ? v.reduceMotion : DEFAULTS.reduceMotion, clipOrder: v.clipOrder === "best" ? "best" : "new" };
}
export function useDevicePrefs() {
  const [prefs, setPrefs] = useState<DevicePrefs>(DEFAULTS), [saved, setSaved] = useState<boolean | null>(null);
  useEffect(() => {
    let loaded = DEFAULTS;
    try { loaded = readPrefs(JSON.parse(window.localStorage.getItem(KEY) ?? "null")); } catch { /* defaults */ }
    // Read once on load; storage is outside React.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(loaded);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("cf-reduce-motion", prefs.reduceMotion); }, [prefs.reduceMotion]);
  const update = (next: Partial<DevicePrefs>) => {
    const value = readPrefs({ ...prefs, ...next });
    setPrefs(value);
    try { window.localStorage.setItem(KEY, JSON.stringify(value)); setSaved(true); } catch { setSaved(false); }
  };
  return { prefs, update, saved, reset: () => update(DEFAULTS) };
}

// linkTwitch: Sign in with Twitch is set up here but this workspace hasn't linked an account yet (the step before
// dropping Cloudflare Access), so Account & data says so.
export function SettingsNav({ tab, onTab, tabs, linkTwitch = false }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; tabs: SettingsTab[]; linkTwitch?: boolean }) {
  return <nav className="settings-menu" aria-label="Settings sections">
    {SETTINGS_TABS.filter(t => tabs.includes(t.id)).map(t => <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}><strong>{t.title}{t.id === "account" && linkTwitch && <span className="settings-badge">Link Twitch</span>}</strong><small>{t.desc}</small></button>)}
  </nav>;
}

export function scopeOf(tab: SettingsTab) { return SETTINGS_TABS.find(t => t.id === tab)?.scope ?? ""; }

// Settings → This device.
export function DeviceSettings({ prefs, update, saved, reset }: ReturnType<typeof useDevicePrefs>) {
  return <section className="panel settings-group"><div className="group-head"><div><h2>How the app looks here</h2><p>Saved in this browser, not your account. Clips and workspace settings aren&apos;t affected.</p></div></div><div className="group-body">
    <label className="check-row"><input type="checkbox" checked={prefs.reduceMotion} onChange={e => update({ reduceMotion: e.target.checked })}/><span>Reduce motion<small>Fewer interface animations and transitions. Clip videos aren&apos;t changed.</small></span></label>
    <label>Clip library order<select value={prefs.clipOrder} onChange={e => update({ clipOrder: e.target.value === "best" ? "best" : "new" })}><option value="new">Newest first</option><option value="best">Best first</option></select><small>How the clip library is sorted when you open it.</small></label>
    <label>Start fresh<button type="button" className="secondary" onClick={() => { if (window.confirm("Reset this device's preferences to the defaults?")) reset(); }}>Reset defaults</button><small>Only these preferences; nothing in your workspace changes.</small></label>
    <p className="settings-saved" role="status">{saved === true ? "Saved on this device." : saved === false ? "Applied for now: this browser won't keep it (storage is blocked)." : ""}</p>
  </div></section>;
}
