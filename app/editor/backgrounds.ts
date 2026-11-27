// Split-screen backgrounds: the workspace's library videos and images, and its other clips (by their unframed source).
// Only those at least as long as the clip (as trimmed now) are offered; a library video of unknown length counts.
import type { Edit } from "./types";

export type BgVideo = { id: string; name: string; duration?: number | null; content_type?: string };
export type BgClip = { id: string; streamer: string | null; duration: number; created_at: string };

export function backgroundChoice(edit: Edit, backgrounds: BgVideo[], bgClips: BgClip[]) {
  const len = edit.trim.end - edit.trim.start, fits = (d?: number | null) => !d || d + 0.05 >= len;
  const fitLibrary = backgrounds.filter(b => fits(b.duration)), fitClips = bgClips.filter(c => c.duration + 0.05 >= len);
  const hiddenShort = backgrounds.length - fitLibrary.length + bgClips.length - fitClips.length;
  const chosen = edit.frame.background ?? null, chosenTooShort = !!chosen && !fitLibrary.some(b => b.id === chosen) && !fitClips.some(c => "clip:" + c.id === chosen);
  const preview = chosen ?? fitLibrary[0]?.id ?? null;
  const previewIsImage = !!preview && !!backgrounds.find(b => b.id === preview)?.content_type?.startsWith("image/");
  return { len, fitLibrary, fitClips, hiddenShort, chosenTooShort, preview, previewIsImage };
}

export const secs = (n: number) => n >= 60 ? Math.floor(n / 60) + ":" + String(Math.round(n % 60)).padStart(2, "0") : Math.round(n) + "s";
