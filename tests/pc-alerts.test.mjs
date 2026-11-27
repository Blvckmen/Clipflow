import { test } from "node:test";
import assert from "node:assert/strict";
import { pcAlertStep } from "../lib/pc-alerts.mjs";

const now = Date.parse("2026-11-27T10:00:00Z"), ago = min => new Date(now - min * 60_000).toISOString();

test("one message when the PC goes offline, none while it stays offline, one when it's back", () => {
  const off = pcAlertStep({ lastSeen: ago(20), previous: null, now });
  assert.equal(off.state, "offline");
  assert.match(off.message, /offline for 20 minutes \(last seen 09:40 UTC\)/);
  assert.deepEqual(pcAlertStep({ lastSeen: ago(60), previous: "offline", now }), { state: "offline", message: null });
  assert.deepEqual(pcAlertStep({ lastSeen: ago(1), previous: "offline", now }), { state: null, message: "✅ Your Clipflow PC is back online." });
  assert.deepEqual(pcAlertStep({ lastSeen: ago(14), previous: null, now }), { state: null, message: null }, "a few missed check-ins aren't offline");
});

test("falling behind: when the oldest clip has waited 30 minutes, and caught up after", () => {
  const behind = pcAlertStep({ lastSeen: ago(0), oldestWaitMin: 45, now });
  assert.equal(behind.state, "behind");
  assert.match(behind.message, /waited 45 minutes/);
  assert.equal(pcAlertStep({ lastSeen: ago(0), oldestWaitMin: 25, now }).state, null);
  assert.match(pcAlertStep({ lastSeen: ago(0), oldestWaitMin: 0, previous: "behind", now }).message, /caught up/);
  assert.equal(pcAlertStep({ lastSeen: ago(30), oldestWaitMin: 90, now }).state, "offline", "offline wins: its queue isn't moving anyway");
});

test("no alerts for a PC stopped from the dashboard, paused automation, or one never connected", () => {
  assert.deepEqual(pcAlertStep({ lastSeen: ago(120), power: "stopped", previous: "offline", now }), { state: null, message: null }, "closed quietly");
  assert.deepEqual(pcAlertStep({ lastSeen: ago(120), control: "paused", now }), { state: null, message: null });
  assert.deepEqual(pcAlertStep({ lastSeen: null, now }), { state: null, message: null });
});
