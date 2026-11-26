// Viewers' Twitch clips: finding them through Helix (with a fake Twitch here) and picking which to import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Twitch, clipUrl, momentOf, momentTime, pickClips, sameMoment, twitchLogin, viewerSettings } from "../twitch.mjs";
import { validateControl } from "../core.mjs";
import { helixQuery } from "../../lib/twitch-app.mjs";

test("without its own Twitch app the worker looks clips up through the site, with the site's reasons", async () => {
  const calls = [];
  const via = async (resource, params) => {
    calls.push(resource + "?" + params);
    if (resource === "users") return Response.json({ data: [{ id: "42", login: params.get("login") }] });
    if (resource === "clips") return Response.json({ data: [{ id: "c1", view_count: 50, video_id: "9" }] });
    if (resource === "videos") return Response.json({ data: [{ id: "9", created_at: "2026-11-26T10:00:00Z" }] });
  };
  const t = Twitch.viaSite(via);
  const clips = await t.clips("somechannel", new Date("2026-11-26T09:00:00Z"));
  assert.equal(clips[0].id, "c1");
  assert.equal((await t.startsOf(clips)).get("9"), Date.parse("2026-11-26T10:00:00Z"));
  assert.deepEqual(calls.map(c => c.split("?")[0]), ["users", "clips", "videos"]);
  assert.ok(helixQuery(new URLSearchParams([["resource", "clips"], ...new URLSearchParams(calls[1].split("?")[1])])), "what the worker sends is what the site allows");
  // The site's own reason (x-clipflow) is shown; a plain failure isn't quoted.
  const noApp = Twitch.viaSite(async () => Response.json({ error: "This site has no Twitch app set up yet." }, { status: 501, headers: { "x-clipflow": "1" } }));
  await assert.rejects(noApp.userId("x_y"), /no Twitch app set up yet/);
  const down = Twitch.viaSite(async () => new Response(null, { status: 502 }));
  await assert.rejects(down.userId("x_y"), /^Error: Twitch users failed \(HTTP 502\)$/);
});

test("the site lends its Twitch app only for the lookups viewers' clips need", () => {
  const q = (...pairs) => helixQuery(new URLSearchParams(pairs));
  assert.equal(q(["resource", "users"], ["login", "kaicenat"]).params.toString(), "login=kaicenat");
  assert.ok(q(["resource", "clips"], ["broadcaster_id", "123"], ["started_at", "2026-11-26T09:00:00.000Z"], ["ended_at", "2026-11-26T10:00:00.000Z"], ["first", "20"]));
  assert.equal(q(["resource", "videos"], ["id", "1"], ["id", "2"]).params.getAll("id").length, 2);
  for (const bad of [
    [["resource", "streams"], ["user_login", "x"]],
    [["resource", "users"]],
    [["resource", "users"], ["login", "x"], ["login", "y"]],
    [["resource", "users"], ["login", "Bad Name"]],
    [["resource", "users"], ["id", "1"]],
    [["resource", "clips"], ["broadcaster_id", "1"], ["first", "500"]],
    [["resource", "clips"], ["broadcaster_id", "1"], ["started_at", "yesterday"]],
    [["resource", "toString"], ["login", "x"]],
    [["login", "x"]],
  ]) assert.equal(helixQuery(new URLSearchParams(bad)), null, JSON.stringify(bad));
});

test("only Twitch channels have viewer clips to import", () => {
  assert.equal(twitchLogin("https://www.twitch.tv/Some_Streamer"), "some_streamer");
  assert.equal(twitchLogin("https://twitch.tv/name/videos"), "name");
  assert.equal(twitchLogin("https://kick.com/name"), null);
  assert.equal(twitchLogin("https://www.twitch.tv/"), null);
  assert.equal(twitchLogin("not a url"), null);
  assert.equal(clipUrl("AwkwardHelplessSalamander-Kappa_1"), "https://clips.twitch.tv/AwkwardHelplessSalamander-Kappa_1");
  assert.throws(() => clipUrl("../../etc"), /Invalid/);
});

test("the most-viewed clips go first; too few views, too short or already imported are skipped", () => {
  const list = [
    { id: "a", view_count: 4, duration: 30, created_at: "2026-11-20T01:00:00Z" },
    { id: "b", view_count: 90, duration: 30, created_at: "2026-11-20T02:00:00Z" },
    { id: "c", view_count: 40, duration: 8, created_at: "2026-11-20T03:00:00Z" },
    { id: "d", view_count: 12, duration: 60, created_at: "2026-11-20T04:00:00Z" },
    { id: "e", view_count: 50, duration: 25, created_at: "2026-11-20T05:00:00Z" },
  ];
  assert.deepEqual(pickClips(list, { minViews: 10, seen: new Set(["e"]), max: 2 }).map(c => c.id), ["b", "d"]);
  assert.deepEqual(pickClips(list, { minViews: 3, seen: new Set(), max: 5 }).map(c => c.id), ["b", "e", "d", "a"]);
  assert.deepEqual(pickClips(null, { minViews: 3, seen: new Set(), max: 5 }), []);
});

test("several viewers' clips of one moment are imported once", () => {
  const v = (id, views, offset, duration = 30, created_at = "2026-11-21T12:00:00Z", video_id = "v1") => ({ id, view_count: views, vod_offset: offset, duration, created_at, video_id });
  // The GTA 6 ending: three viewers, overlapping places in the broadcast.
  const list = [v("end1", 42, 11280), v("end2", 22, 11310), v("end3", 67, 11300, 50.4), v("other", 30, 44490), v("vod2", 50, 11300, 30, undefined, "v2")];
  assert.deepEqual(pickClips(list, { minViews: 10, seen: new Set(), max: 5 }).map(c => c.id), ["end3", "vod2", "other"], "the most viewed of the moment, and the same time in another broadcast is another moment");
  // Already imported (remembered moment): the others of that moment stay out.
  assert.deepEqual(pickClips(list, { minViews: 10, seen: new Set(["end1"]), max: 5, taken: [momentOf(list[0])] }).map(c => c.id), ["vod2", "other"]);
  // Too far apart to be one moment (more than 5 seconds between them).
  assert.equal(sameMoment(v("a", 1, 100, 30), v("b", 1, 136, 30)), false);
  assert.equal(sameMoment(v("a", 1, 100, 30), v("b", 1, 134, 30)), true);
  // No place in the broadcast yet: clips made within a clip's length of each other are one moment.
  const live = (id, at) => ({ id, view_count: 20, duration: 30, created_at: at, video_id: "", vod_offset: null });
  assert.deepEqual(pickClips([live("x", "2026-11-22T10:00:00Z"), live("y", "2026-11-22T10:00:20Z"), live("z", "2026-11-22T10:05:00Z")], { minViews: 10, seen: new Set(), max: 5 }).map(c => c.id), ["x", "z"]);
  // The same time on another channel is another moment.
  const on = (c, broadcaster_id) => ({ ...c, broadcaster_id });
  assert.equal(sameMoment(on(live("p", "2026-11-22T10:00:00Z"), "kai"), on(live("q", "2026-11-22T10:00:10Z"), "agent")), false);
  assert.equal(sameMoment(on(live("p", "2026-11-22T10:00:00Z"), "kai"), on(live("q", "2026-11-22T10:00:10Z"), "kai")), true);
  assert.equal(momentOf(on(list[0], "kai")).broadcaster_id, "kai");
});

test("signs in once with the app's keys, looks the channel up once, and signs in again when the token expires", async () => {
  const calls = [];
  let tokens = 0, expire = false;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname + (u.pathname.endsWith("/clips") ? "" : u.search));
    if (u.host === "id.twitch.tv") {
      assert.equal(init.body.get("client_secret"), "shh");
      return Response.json({ access_token: "t" + ++tokens, expires_in: 5000 });
    }
    assert.equal(init.headers["Client-Id"], "app");
    if (expire && init.headers.Authorization === "Bearer t1") return new Response("", { status: 401 });
    if (u.pathname === "/helix/users") return Response.json({ data: [{ id: "123", login: u.searchParams.get("login") }] });
    assert.equal(u.searchParams.get("broadcaster_id"), "123");
    assert.ok(Date.parse(u.searchParams.get("started_at")) > 0);
    return Response.json({ data: [{ id: "clip1", view_count: 9, duration: 30 }] });
  };
  const twitch = new Twitch({ clientId: "app", clientSecret: "shh", fetch });
  assert.deepEqual((await twitch.clips("name", new Date(Date.now() - 86_400_000))).map(c => c.id), ["clip1"]);
  await twitch.clips("name", new Date());
  assert.equal(tokens, 1);
  assert.equal(calls.filter(c => c.startsWith("/helix/users")).length, 1, "the channel id is remembered");
  expire = true;
  await twitch.clips("name", new Date());
  assert.equal(tokens, 2, "a 401 signs in again and retries");
});

test("a refused sign-in says so without echoing anything Twitch sent back", async () => {
  const twitch = new Twitch({ clientId: "app", clientSecret: "shh", fetch: async () => new Response("client_secret=shh is invalid", { status: 403 }) });
  await assert.rejects(twitch.clips("name", new Date()), error => /refused the app's Client ID or secret/.test(error.message) && !error.message.includes("shh"));
  assert.equal(Twitch.fromEnv({}), null, "no app, no import");
  assert.ok(Twitch.fromEnv({ TWITCH_CLIENT_ID: "a", TWITCH_CLIENT_SECRET: "b" }));
});

test("the import setting comes from the dashboard: off for older dashboards, checked otherwise", () => {
  const config = over => ({ control: "running", streamers: [], duration: 45, captions: true, dailyLimit: 5, ...over });
  assert.equal(validateControl(config()).importClips, 0);
  assert.equal(validateControl(config({ importClips: 10 })).importClips, 10);
  assert.throws(() => validateControl(config({ importClips: -1 })), /clip import/);
  assert.throws(() => validateControl(config({ importClips: "lots" })), /clip import/);
});

test("each streamer can have viewer clips on or off, its own views, daily cap, freshness and ask-first", () => {
  const ws = { importClips: 50, viewerClips: { perDay: 3, maxHours: 12, ask: false } };
  assert.deepEqual(viewerSettings(ws, {}), { on: true, minViews: 50, perDay: 3, maxHours: 12, ask: false }, "the workspace's");
  assert.deepEqual(viewerSettings(ws, { viewerClips: { minViews: 2000, perDay: 1, ask: true } }), { on: true, minViews: 2000, perDay: 1, maxHours: 12, ask: true });
  assert.equal(viewerSettings(ws, { viewerClips: { on: false } }).on, false, "off for one streamer");
  assert.deepEqual(viewerSettings({ importClips: 0 }, { viewerClips: { on: true } }), { on: true, minViews: 10, perDay: 2, maxHours: 24, ask: false }, "on for one streamer while the workspace is off");
  assert.equal(viewerSettings({ importClips: 0 }, {}).on, false);
  assert.deepEqual(viewerSettings({ importClips: 5, viewerClips: { perDay: 99, maxHours: 0 } }, { viewerClips: { minViews: -3 } }), { on: true, minViews: 5, perDay: 2, maxHours: 24, ask: false }, "out of range is ignored");
});

test("a clip's moment is when it happened in the broadcast, so old moments clipped today are not fresh", () => {
  const starts = new Map([["v1", Date.parse("2026-11-20T10:00:00Z")]]);
  assert.equal(momentTime({ video_id: "v1", vod_offset: 3600, created_at: "2026-11-22T09:00:00Z" }, starts), Date.parse("2026-11-20T11:00:00Z"));
  assert.equal(momentTime({ video_id: "", vod_offset: null, created_at: "2026-11-22T09:00:00Z" }, starts), Date.parse("2026-11-22T09:00:00Z"), "live clip: when it was made");
  assert.equal(momentTime({ video_id: "gone", vod_offset: 10, created_at: "2026-11-22T09:00:00Z" }, starts), Date.parse("2026-11-22T09:00:00Z"));
  const now = Date.parse("2026-11-22T10:00:00Z"), fresh = c => now - momentTime(c, starts) <= 24 * 3_600_000;
  const list = [{ id: "old", view_count: 500, duration: 30, video_id: "v1", vod_offset: 3600, created_at: "2026-11-22T09:00:00Z", broadcaster_id: "b" },
    { id: "new", view_count: 20, duration: 30, video_id: "", vod_offset: null, created_at: "2026-11-22T09:30:00Z", broadcaster_id: "b" }];
  assert.deepEqual(pickClips(list, { minViews: 10, seen: new Set(), max: 5, keep: fresh }).map(c => c.id), ["new"]);
});

test("broadcast start times are looked up once, a hundred at a time", async () => {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname === "/oauth2/token") return Response.json({ access_token: "t", expires_in: 3600 });
    return Response.json({ data: u.searchParams.getAll("id").map(id => ({ id, created_at: "2026-11-20T10:00:00Z" })) });
  };
  const twitch = new Twitch({ clientId: "app", clientSecret: "s", fetch });
  const starts = await twitch.startsOf([{ video_id: "111" }, { video_id: "222" }, { video_id: "" }, { video_id: "111" }]);
  assert.equal(starts.get("222"), Date.parse("2026-11-20T10:00:00Z"));
  await twitch.startsOf([{ video_id: "111" }]);
  assert.equal(calls.filter(p => p === "/helix/videos").length, 1, "remembered");
});

test("picked viewer clips come from the dashboard and are checked", () => {
  const config = over => ({ control: "running", streamers: [], duration: 45, captions: true, dailyLimit: 5, ...over });
  assert.deepEqual(validateControl(config()).viewerClipPicks, []);
  assert.equal(validateControl(config({ importClips: 5000 })).importClips, 5000);
  assert.throws(() => validateControl(config({ viewerClipPicks: [{ id: "../x", streamerId: "00000000-0000-0000-0000-000000000000", duration: 30 }] })), /viewer clip pick/);
  assert.throws(() => validateControl(config({ viewerClips: [] })), /viewer clip settings/);
});
