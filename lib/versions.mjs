// Saved versions of a clip's edit (table clip_versions): how many are kept, and the short line that names one in the
// editor's version list.
import { TEMPLATES, templateOf } from "../worker/edit.mjs";

export const KEEP_VERSIONS = 20;

// "32.4s · Top split · subtitles · title": the clip's length, its template, and which text shows on it.
export function versionLabel(edit) {
  if (!edit || typeof edit !== "object" || !edit.trim || !edit.frame) return "Saved edit";
  const secs = Math.round((edit.trim.end - edit.trim.start) * 10) / 10;
  const id = templateOf(edit.frame), template = TEMPLATES.find(t => t.id === id)?.label ?? "Custom";
  const parts = [secs + "s", template];
  if (edit.captions?.on) parts.push("subtitles");
  if (edit.hook?.text && edit.hook.on !== false) parts.push("title");
  return parts.join(" · ");
}
