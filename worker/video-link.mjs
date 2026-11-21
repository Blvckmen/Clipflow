// Video links that can be imported as recordings: a Twitch VOD, a Kick VOD or a YouTube video. Shared by the
// dashboard (which checks what is pasted) and the worker; only the rebuilt URL is ever passed to a downloader.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export const PLATFORM_NAMES = { twitch: "Twitch", kick: "Kick", youtube: "YouTube" };

// { platform, id, url } for a supported video link, else null.
export function videoLink(input) {
  let u;
  try { u = new URL(String(input ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, ""), path = u.pathname.split("/").filter(Boolean);
  if (host === "twitch.tv" && path.length === 2 && path[0] === "videos" && /^\d{5,15}$/.test(path[1]))
    return { platform: "twitch", id: path[1], url: "https://www.twitch.tv/videos/" + path[1] };
  if (host === "kick.com" && path.length === 3 && path[1] === "videos" && /^[A-Za-z0-9_-]{1,40}$/.test(path[0]) && UUID.test(path[2])) {
    const id = path[2].toLowerCase();
    return { platform: "kick", id, url: "https://kick.com/" + path[0].toLowerCase() + "/videos/" + id };
  }
  let yt = null;
  if (host === "youtu.be" && path.length === 1) yt = path[0];
  else if (host === "youtube.com" && path.length === 1 && path[0] === "watch") yt = u.searchParams.get("v");
  else if (host === "youtube.com" && path.length === 2 && path[0] === "live") yt = path[1];
  if (yt && YOUTUBE_ID.test(yt)) return { platform: "youtube", id: yt, url: "https://www.youtube.com/watch?v=" + yt };
  return null;
}
