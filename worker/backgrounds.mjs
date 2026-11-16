// Split-screen background videos. The dashboard keeps each workspace's library; the worker downloads a video the
// first time a clip needs it and keeps it in DATA_DIR/backgrounds.
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A number from 0 to 1 that is always the same for this text.
const unit = text => createHash("sha256").update(text).digest().readUInt32BE(0) / 2 ** 32;

// Which background a clip uses and where in it to start: the one chosen in the editor if it is still in the library,
// otherwise one picked from the library by the clip's id, so re-rendering the clip never swaps it.
export function chooseBackground(edit, clipId, library) {
  if (edit?.frame?.mode !== "split" || !library?.length) return null;
  const chosen = edit.frame.background && library.find(b => b.id === edit.frame.background);
  return chosen ?? library[Math.floor(unit(clipId) * library.length) % library.length];
}

// Where in the background to start: a spot of its own for each clip, leaving room for the clip to play through.
export function backgroundStart(clipId, backgroundSeconds, clipSeconds) {
  const room = Math.max(0, backgroundSeconds - clipSeconds);
  return Math.round(unit(clipId + ":start") * room * 10) / 10;
}

export function validBackgrounds(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) throw new Error("Invalid backgrounds");
  for (const b of list) if (!/^[0-9a-f-]{36}$/i.test(b?.id) || !Number.isInteger(b.size) || b.size < 1) throw new Error("Invalid background");
  return list;
}

// The local copy of a background, downloading it once (`fetchFile(id)` returns its bytes). A copy whose size no
// longer matches the library's is fetched again.
export async function localBackground(dataDir, entry, fetchFile) {
  const dir = join(dataDir, "backgrounds"), file = join(dir, entry.id + ".mp4");
  const have = await stat(file).catch(() => null);
  if (have?.size === entry.size) return file;
  await mkdir(dir, { recursive: true });
  const bytes = await fetchFile(entry.id);
  if (bytes.length !== entry.size) throw new Error("Background " + entry.id + " downloaded incompletely");
  await writeFile(file + ".part", bytes);
  await rename(file + ".part", file);
  return file;
}
