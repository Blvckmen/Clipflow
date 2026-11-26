// Packs the worker for download (Connect worker → Download the worker): outputs/clipflow-worker.zip, with the
// worker's tracked files in a clipflow-worker/ folder, minus its tests and tools, plus site.txt (this site's address,
// so setup-windows.ps1 needn't ask) and version.txt. Only files git tracks go in, so worker/.env and worker/data never
// do. Run by scripts/deploy-cloudflare.mjs, which uploads it to R2 (downloads/clipflow-worker.zip) for
// app/api/downloads/worker to hand to signed-in people only. Not in public/: a static file there is served to anyone
// once Cloudflare Access no longer guards the dashboard. `node scripts/pack-worker.mjs [site]` by hand.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
export const ZIP_PATH = join(root, "outputs", "clipflow-worker.zip");
export const ZIP_KEY = "downloads/clipflow-worker.zip";

// Which tracked worker files are shipped: not tests, tools, local data or Python caches.
export const shipped = path => path.startsWith("worker/") && !/^worker\/(test|tools|data|__pycache__)\//.test(path) && !/(^|\/)\.env/.test(path);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A zip archive (deflate, UTF-8 names) of [{ name, data: Buffer }]. */
export function zip(files, when = new Date()) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8"), packed = deflateRawSync(data), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export function packWorker(site = "") {
  // Files as committed at HEAD, not as they are on disk: a folder shared with other work may hold unfinished edits.
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD", "worker"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).filter(shipped).sort();
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const files = tracked.map(path => ({ name: "clipflow-worker/" + path.slice("worker/".length), data: execFileSync("git", ["show", "HEAD:" + path], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) }));
  files.push({ name: "clipflow-worker/version.txt", data: Buffer.from(commit + "\n") });
  if (site) files.push({ name: "clipflow-worker/site.txt", data: Buffer.from(site + "\n") });
  mkdirSync(dirname(ZIP_PATH), { recursive: true });
  writeFileSync(ZIP_PATH, zip(files));
  return { path: ZIP_PATH, files: files.length, commit };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const r = packWorker(process.argv[2] ?? "");
  console.log("Packed " + r.files + " worker files (" + r.commit + ") into " + r.path);
}
