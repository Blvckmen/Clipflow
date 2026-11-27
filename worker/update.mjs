// Automatic updates for a worker installed from the download (Connect worker → Download the worker). Each deploy
// packs the worker (scripts/pack-worker.mjs, with version.txt) and tells workers its version (config.workerVersion);
// a worker on another version downloads it (GET /api/worker/download, with its own token), backs up every file it
// replaces, writes the new ones and restarts once idle. run-windows.ps1 puts the backup back if the new version keeps
// crashing on start. Never: a worker run from a git checkout (a developer's), AUTO_UPDATE=off, .env or data/.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export const PREFIX = "clipflow-worker/";

/** This worker's version (version.txt from the download), or null when it doesn't have one (run from a checkout). */
export async function localVersion(workerDir) {
  const v = await readFile(join(workerDir, "version.txt"), "utf8").catch(() => null);
  return v && /^[0-9a-f]{7,40}$/.test(v.trim()) ? v.trim() : null;
}

/** A folder inside a git checkout: a developer's, updated with git, never by itself. */
export function inGitCheckout(dir) {
  for (let d = dir, i = 0; i < 6; i++, d = dirname(d)) { if (existsSync(join(d, ".git"))) return true; if (dirname(d) === d) break; }
  return false;
}

/** Whether to update: only a downloaded worker on a different version than the site's, unless switched off. */
export function shouldUpdate({ local, site, gitCheckout, setting }) {
  if (String(setting ?? "on").toLowerCase() === "off" || gitCheckout) return false;
  return !!local && typeof site === "string" && /^[0-9a-f]{7,40}$/.test(site) && site !== local;
}

/** The files of a zip archive (stored or deflated entries, as scripts/pack-worker.mjs writes): [{ name, data }]. */
export function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(end + 10), out = [];
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("Damaged zip directory");
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28), packed = buf.subarray(local, local + size);
    if (method !== 0 && method !== 8) throw new Error("Unsupported zip entry " + name);
    if (!name.endsWith("/")) out.push({ name, data: method === 8 ? inflateRawSync(packed) : Buffer.from(packed) });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/**
 * The files to write, as paths inside the worker folder: those under clipflow-worker/, never .env (the PC's own
 * settings), data/ (recordings, clips, its database) or anything that would land outside the folder.
 */
export function updateFiles(entries) {
  const out = [];
  for (const { name, data } of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const rel = normalize(name.slice(PREFIX.length));
    if (!rel || rel.startsWith("..") || /^[\\/]/.test(rel) || /^[a-z]:/i.test(rel)) continue;
    const first = rel.split(/[\\/]/)[0].toLowerCase();
    if (first === "data" || first === ".env" || first.startsWith(".env.") || first === "node_modules") continue;
    out.push({ rel, data });
  }
  return out;
}

/** Writes `files` into `workerDir`, first copying each file it replaces into `backupDir` (same paths). */
export async function applyUpdate(files, workerDir, backupDir) {
  for (const { rel } of files) {
    const target = join(workerDir, rel);
    if (existsSync(target)) { await mkdir(dirname(join(backupDir, rel)), { recursive: true }); await copyFile(target, join(backupDir, rel)); }
  }
  for (const { rel, data } of files) {
    const target = join(workerDir, rel);
    if (!target.startsWith(workerDir + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}
