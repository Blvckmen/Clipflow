import { test } from "node:test";
import assert from "node:assert/strict";
import { inTurn } from "../writer.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("requests to the local model go one at a time; each starts only when its turn comes", async () => {
  const log = [];
  const call = (name, ms) => inTurn(null, async () => { log.push(name + " start"); await sleep(ms); log.push(name + " end"); return name; });
  const results = await Promise.all([call("a", 40), call("b", 5), call("c", 5)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c start", "c end"]);
});

test("a failed request doesn't block the next; a cancelled clip's waiting request is never sent", async () => {
  const failed = inTurn(null, async () => { await sleep(10); throw new Error("model down"); });
  const controller = new AbortController();
  let sent = false;
  const cancelled = inTurn(controller.signal, async () => { sent = true; });
  controller.abort();
  const next = inTurn(null, async () => "ok");
  await assert.rejects(failed, /model down/);
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(sent, false);
  assert.equal(await next, "ok");
});
