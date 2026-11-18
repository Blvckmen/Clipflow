// Split-screen background videos. The dashboard keeps each workspace's library; the worker downloads a video the
// first time a clip needs it and keeps it in DATA_DIR/backgrounds. A background can also be another clip from the
// gallery (edit.frame.background "clip:<id>"), used through that clip's unframed source.
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A number from 0 to 1 that is always the same for this text.
const unit = text => createHash("sha256").update(text).digest().readUInt32BE(0) / 2 ** 32;

// Which background a clip uses: another gallery clip or a library background chosen in the editor (or pinned at the
// first render), otherwise one picked from the library. Only videos at least as long as the clip are picked (images,
// and videos of unknown length, always fit); longer ones are cut to the clip's length.
// With `lastUsed` (background id -> when it was last used, ms) the pick rotates: backgrounds whose name shares a word
// with the stream `title` come first (name a loop "Fortnite gameplay" for Fortnite streams), then the one that has
// gone longest without being used. Without it, the clip's id picks one, the same each time.
export function chooseBackground(edit, clipId, library, clipSeconds = 0, { lastUsed = null, title = "" } = {}) {
  if (edit?.frame?.mode !== "split") return null;
  const ref = edit.frame.background;
  if (typeof ref === "string" && ref.startsWith("clip:")) return { id: ref, kind: "clip", clip: ref.slice(5), size: null };
  const fits = (library ?? []).filter(b => !(b.duration > 0) || b.duration + 0.05 >= clipSeconds);
  if (!fits.length) return null;
  const chosen = ref && fits.find(b => b.id === ref);
  if (chosen) return chosen;
  if (!lastUsed) return fits[Math.floor(unit(clipId) * fits.length) % fits.length];
  const words = new Set(String(title).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const matches = b => (String(b.name ?? "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some(w => words.has(w));
  const pool = words.size && fits.some(matches) ? fits.filter(matches) : fits;
  const used = b => (lastUsed instanceof Map ? lastUsed.get(b.id) : lastUsed[b.id]) ?? 0;
  return [...pool].sort((a, b) => used(a) - used(b) || unit(clipId + a.id) - unit(clipId + b.id))[0];
}

// Where in the background to start: a spot of its own for each clip, leaving room for the clip to play through.
export function backgroundStart(clipId, backgroundSeconds, clipSeconds) {
  const room = Math.max(0, backgroundSeconds - clipSeconds);
  return Math.round(unit(clipId + ":start") * room * 10) / 10;
}

export function validBackgrounds(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) throw new Error("Invalid backgrounds");
  for (const b of list) {
    if (!/^[0-9a-f-]{36}$/i.test(b?.id) || !Number.isInteger(b.size) || b.size < 1) throw new Error("Invalid background");
    if (b.duration !== undefined && b.duration !== null && !(typeof b.duration === "number" && b.duration >= 0)) throw new Error("Invalid background length");
    // Dashboards that predate image backgrounds send videos only.
    b.kind ??= "video";
    if (!["video", "image"].includes(b.kind)) throw new Error("Invalid background kind");
  }
  return list;
}

// The local copy of a background, downloading it once (`fetchFile(entry)` returns its bytes). A library copy whose
// size no longer matches the library's is fetched again; a gallery clip's source never changes, so any copy is used.
export async function localBackground(dataDir, entry, fetchFile) {
  const ext = entry.kind === "image" ? ({ "image/png": ".png", "image/webp": ".webp" }[entry.type] ?? ".jpg") : ".mp4";
  const dir = join(dataDir, "backgrounds"), file = join(dir, (entry.kind === "clip" ? "clip-" + entry.clip : entry.id) + ext);
  const have = await stat(file).catch(() => null);
  if (have && (entry.size === null ? have.size > 0 : have.size === entry.size)) return file;
  await mkdir(dir, { recursive: true });
  const bytes = await fetchFile(entry);
  if (entry.size !== null && bytes.length !== entry.size) throw new Error("Background " + entry.id + " downloaded incompletely");
  if (!bytes.length) throw new Error("Background " + entry.id + " is empty");
  await writeFile(file + ".part", bytes);
  await rename(file + ".part", file);
  return file;
}
