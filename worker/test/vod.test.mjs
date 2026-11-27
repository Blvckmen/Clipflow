import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { downloadPlan, toRecording, videoLink } from "../vod.mjs";
import { validateControl } from "../core.mjs";
const run = promisify(execFile);

test("video links: Twitch and Kick past broadcasts and YouTube videos, rebuilt to one form", () => {
  assert.deepEqual(videoLink("https://www.twitch.tv/videos/2290123456?t=1h2m3s"), { platform: "twitch", id: "2290123456", url: "https://www.twitch.tv/videos/2290123456" });
  assert.equal(videoLink("twitch.tv/videos/123"), null, "needs a scheme");
  assert.equal(videoLink("https://m.twitch.tv/videos/2290123456")?.url, "https://www.twitch.tv/videos/2290123456");
  const kick = "https://kick.com/DDG/videos/6F1C2D3E-1111-4222-8333-444455556666";
  assert.deepEqual(videoLink(kick), { platform: "kick", id: "6f1c2d3e-1111-4222-8333-444455556666", url: "https://kick.com/ddg/videos/6f1c2d3e-1111-4222-8333-444455556666" });
  for (const yt of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "https://youtu.be/dQw4w9WgXcQ?si=x", "https://youtube.com/live/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"])
    assert.equal(videoLink(yt)?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", yt);
  for (const bad of ["https://www.twitch.tv/kaicenat", "https://www.twitch.tv/videos/abc", "https://twitch.tv.evil.com/videos/2290123456", "https://kick.com/ddg", "https://kick.com/ddg/videos/not-a-uuid",
    "https://www.youtube.com/watch?v=short", "https://www.youtube.com/@mrbeast", "ftp://www.twitch.tv/videos/2290123456", "javascript:alert(1)", "", null, "https://www.youtube.com/watch?v=dQw4w9WgXcQ\n--exec"])
    assert.equal(videoLink(bad), null, String(bad));
});

test("downloads use yt-dlp when installed, else streamlink (not for YouTube); the link goes after --", () => {
  const twitch = videoLink("https://www.twitch.tv/videos/2290123456"), yt = videoLink("https://youtu.be/dQw4w9WgXcQ");
  const withYtDlp = downloadPlan(yt, "D", { ytdlp: { binary: "py", prefix: ["-m", "yt_dlp"] } });
  assert.equal(withYtDlp.binary, "py");
  assert.deepEqual(withYtDlp.args.slice(0, 2), ["-m", "yt_dlp"]);
  assert.deepEqual(withYtDlp.args.slice(-2), ["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  const sl = downloadPlan(twitch, "D", { ytdlp: null, streamlink: "streamlink" });
  assert.equal(sl.binary, "streamlink");
  assert.ok(sl.args.includes("https://www.twitch.tv/videos/2290123456"));
  assert.equal(downloadPlan(yt, "D", { ytdlp: null }), null, "YouTube needs yt-dlp");
});

test("a download becomes the recording's MP4: copied when H.264/AAC, re-encoded otherwise", async t => {
  try { await run("ffmpeg", ["-version"]); } catch { return t.skip("ffmpeg not installed"); }
  const dir = await mkdtemp(join(tmpdir(), "vod-"));
  try {
    const probe = async f => JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type:format=duration", "-of", "json", f])).stdout);
    const h264 = join(dir, "a.ts");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", h264]);
    assert.equal(await toRecording(h264, join(dir, "a.mp4")), true, "copied");
    const a = await probe(join(dir, "a.mp4"));
    assert.deepEqual(a.streams.map(s => s.codec_name).sort(), ["aac", "h264"]);
    const vp9 = join(dir, "b.webm");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus", "-shortest", vp9]);
    assert.equal(await toRecording(vp9, join(dir, "b.mp4")), false, "re-encoded");
    const b = await probe(join(dir, "b.mp4"));
    assert.deepEqual(b.streams.map(s => s.codec_name).sort(), ["aac", "h264"]);
    assert.ok(Math.abs(Number(b.format.duration) - 2) < 0.3);
    await writeFile(join(dir, "c.mp4"), "not a video");
    await assert.rejects(toRecording(join(dir, "c.mp4"), join(dir, "d.mp4")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the worker config accepts imports only with links in their rebuilt form", () => {
  const base = () => ({ control: "running", streamers: [], duration: 30, captions: true, dailyLimit: 5 });
  assert.deepEqual(validateControl(base()).imports, [], "older dashboards");
  const id = "6f1c2d3e-1111-4222-8333-444455556666", streamerId = "7f1c2d3e-1111-4222-8333-444455556666";
  assert.equal(validateControl({ ...base(), imports: [{ id, streamerId, url: "https://www.twitch.tv/videos/2290123456" }] }).imports.length, 1);
  for (const url of ["https://twitch.tv/videos/2290123456", "https://www.twitch.tv/videos/2290123456 --exec x", "https://evil.example/x"])
    assert.throws(() => validateControl({ ...base(), imports: [{ id, streamerId, url }] }), /Invalid import/, url);
  assert.throws(() => validateControl({ ...base(), imports: [{ id: "x", streamerId, url: "https://www.twitch.tv/videos/2290123456" }] }), /Invalid import/);
});


test("YouTube authentication is opt-in and not passed to other sources", async () => {
  const { authenticationArgs } = await import("../vod.mjs");
  const youtube=videoLink("https://youtu.be/dQw4w9WgXcQ");
  const ytdlp={binary:"yt-dlp",prefix:[],cookiesFile:"C:/private folder/youtube.txt"};
  assert.deepEqual(authenticationArgs(youtube,{binary:"yt-dlp",prefix:[]}),[]);
  assert.deepEqual(authenticationArgs(youtube,ytdlp),["--cookies",ytdlp.cookiesFile]);
  assert.deepEqual(authenticationArgs({platform:"twitch"},ytdlp),[]);
  const plan=downloadPlan(youtube,"D",{ytdlp});
  assert.equal(plan.args[plan.args.indexOf("--cookies")+1],ytdlp.cookiesFile);
  assert.ok(!plan.args.includes("--cookies-from-browser"));
});

test("YouTube login failures retain an actionable reason even with truncated diagnostics", async () => {
  const { downloadFailure } = await import("../vod.mjs");
  for(const message of ["Sign in to confirm you're not a bot. Use --cookies for the authentication.","yt-dlp failed (exit 1): -from-browser or --cookies for the authentication. See FAQ"]){
    const reason=downloadFailure({platform:"youtube"},new Error(message));
    assert.match(reason,/YouTube requires a signed-in session/);
    assert.match(reason,/YTDLP_COOKIES/);
    assert.ok(reason.length<250);
  }
  assert.equal(downloadFailure({platform:"youtube"},new Error("HTTP Error 404")),"HTTP Error 404");
  assert.equal(downloadFailure({platform:"twitch"},new Error("authentication failed")),"authentication failed");
});
