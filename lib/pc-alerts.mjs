// Discord alerts about the owner's PC (the worker): when it goes offline, when it falls behind, and when it's back.
// One message when a problem starts and one when it clears, never one a minute. Pure; lib/alerts.ts pcAlerts runs it
// for every workspace with a Discord webhook and keeps each one's current state in sync_state.

export const OFFLINE_MIN = 15;  // no check-in for this long: offline
export const BEHIND_MIN = 30;   // the oldest clip ready to be made has waited this long: behind

const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + " UTC";

/**
 * The PC's state now ("offline", "behind" or null for fine) and the message to send, if the state changed.
 * Stopped from the dashboard, or with automation paused or stopped, nothing is expected of it: no alert, and an open
 * problem is closed quietly. A PC that never checked in isn't offline yet (still being set up).
 * @param {{ lastSeen: string | null, oldestWaitMin?: number, power?: string, control?: string, previous?: string | null, now?: number }} input
 * @returns {{ state: "offline" | "behind" | null, message: string | null }}
 */
export function pcAlertStep({ lastSeen, oldestWaitMin = 0, power = "running", control = "running", previous = null, now = Date.now() }) {
  const seen = lastSeen ? Date.parse(lastSeen) : NaN;
  if (power === "stopped" || control !== "running" || !Number.isFinite(seen)) return { state: null, message: null };
  const away = Math.floor((now - seen) / 60_000);
  const state = away >= OFFLINE_MIN ? "offline" : oldestWaitMin >= BEHIND_MIN ? "behind" : null;
  if (state === previous) return { state, message: null };
  if (state === "offline") return { state, message: "⚠️ Your Clipflow PC has been offline for " + away + " minutes (last seen " + hhmm(seen) + "). Nothing is being recorded or clipped. Check that the PC is on, awake and online, and that the worker is running." };
  if (state === "behind") return { state, message: "\u{1F422} Your Clipflow PC is falling behind: the oldest clip has waited " + oldestWaitMin + " minutes to be made. Try Settings → This PC → Computer usage: Maximum, or record fewer channels at once." };
  return { state, message: previous === "offline" ? "✅ Your Clipflow PC is back online." : "✅ Your Clipflow PC has caught up." };
}
