// Viewers' Twitch clips: finding them through Helix (with a fake Twitch here) and picking which to import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Twitch, clipUrl, momentOf, pickClips, sameMoment, twitchLogin } from "../twitch.mjs";
import { validateControl } from "../core.mjs";

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
