import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip } from "../../scripts/pack-worker.mjs";
import { applyUpdate, inGitCheckout, shouldUpdate, unzip, updateFiles } from "../update.mjs";

test("only a downloaded worker on another version updates; never from a git checkout or when switched off", () => {
  assert.equal(shouldUpdate({ local: "abc1234", site: "def5678", gitCheckout: false }), true);
  assert.equal(shouldUpdate({ local: "abc1234", site: "abc1234", gitCheckout: false }), false, "same version");
  assert.equal(shouldUpdate({ local: null, site: "def5678", gitCheckout: false }), false, "no version.txt: run from source");
  assert.equal(shouldUpdate({ local: "abc1234", site: "def5678", gitCheckout: true }), false, "a developer's checkout");
  assert.equal(shouldUpdate({ local: "abc1234", site: "def5678", gitCheckout: false, setting: "OFF" }), false);
  assert.equal(shouldUpdate({ local: "abc1234", site: undefined, gitCheckout: false }), false, "an older site says nothing");
  assert.equal(inGitCheckout(process.cwd()), true, "this repository");
});

test("unzip reads what pack-worker writes; only the worker's own files are taken, never .env, data/ or outside it", () => {
  const files = [["clipflow-worker/main.mjs", "new main"], ["clipflow-worker/sub/x.py", "x"], ["clipflow-worker/.env", "SECRET=1"], ["clipflow-worker/data/worker.sqlite", "db"],
    ["clipflow-worker/../evil.mjs", "no"], ["other/thing", "no"], ["clipflow-worker/version.txt", "def5678\n"]].map(([name, s]) => ({ name, data: Buffer.from(s) }));
  const entries = unzip(zip(files));
  assert.equal(entries.length, files.length);
  assert.equal(entries[0].data.toString(), "new main");
  assert.deepEqual(updateFiles(entries).map(f => f.rel.replace(/\\/g, "/")), ["main.mjs", "sub/x.py", "version.txt"]);
  assert.throws(() => unzip(Buffer.from("not a zip at all, definitely not")), /Not a zip/);
});

test("applyUpdate backs up each file it replaces, then writes the new ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-update-")), worker = join(dir, "w"), backup = join(dir, "backup");
  await mkdir(worker); await writeFile(join(worker, "main.mjs"), "old main"); await writeFile(join(worker, ".env"), "KEEP=1");
  await applyUpdate([{ rel: "main.mjs", data: Buffer.from("new main") }, { rel: join("sub", "x.py"), data: Buffer.from("x") }], worker, backup);
  assert.equal(await readFile(join(worker, "main.mjs"), "utf8"), "new main");
  assert.equal(await readFile(join(backup, "main.mjs"), "utf8"), "old main", "the old file kept");
  assert.equal(await readFile(join(worker, "sub", "x.py"), "utf8"), "x");
  assert.equal(await readFile(join(worker, ".env"), "utf8"), "KEEP=1");
});
