// Connects this PC to a Clipflow workspace with a pairing code from the dashboard (Connect worker → Pair this PC):
//   node worker/pair.mjs https://your-site 4F7K-9Q2M
// It trades the code for a worker token and writes CLIPFLOW_URL and CLIPFLOW_TOKEN into worker/.env, keeping every
// other line there. Restart the worker afterwards so it uses them. Run without arguments to be asked for both.
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** The site's origin, or null if it isn't https (or a local address). */
export function siteOrigin(input) {
  let url;
  try { url = new URL(String(input ?? "").trim()); } catch { return null; }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  return url.protocol === "https:" || (local && url.protocol === "http:") ? url.origin : null;
}

/** worker/.env's text with these keys set: an existing line is replaced in place, a missing one is added. */
export function updateEnv(text, values) {
  const lines = text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  const left = new Map(Object.entries(values));
  const out = lines.map(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || line.trimStart().startsWith("#") || !left.has(m[1])) return line;
    const value = left.get(m[1]); left.delete(m[1]);
    return m[1] + "=" + value;
  });
  for (const [key, value] of left) out.push(key + "=" + value);
  return out.join("\n") + "\n";
}

/** Trades the code for { token, url }; throws with the site's own message when it says no. */
export async function pair(origin, code, { fetch: get = fetch } = {}) {
  let response;
  try {
    response = await get(origin + "/api/worker/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error("Couldn't reach " + origin + ". Check the address and your connection."); }
  const body = await response.json().catch(() => null);
  if (!response.ok || !/^cfw_[0-9a-f]{64}$/.test(body?.token ?? "")) throw new Error(body?.error ?? "The site didn't accept the code (HTTP " + response.status + ").");
  return body;
}

async function main() {
  let [site, code] = process.argv.slice(2);
  if (!site || !code) {
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    site ||= await ask.question("Clipflow site address (e.g. https://clipflow.example.com): ");
    code ||= await ask.question("Pairing code from Connect worker: ");
    ask.close();
  }
  const origin = siteOrigin(site);
  if (!origin) { console.error("Use the site's full https:// address."); process.exit(1); }
  try {
    const { token } = await pair(origin, code);
    const envFile = fileURLToPath(new URL("./.env", import.meta.url));
    const before = await readFile(envFile, "utf8").catch(() => "");
    await writeFile(envFile, updateEnv(before, { CLIPFLOW_URL: origin, CLIPFLOW_TOKEN: token }));
    console.log("Paired. This PC now works for " + origin + ". Restart the worker to use it.");
  } catch (error) { console.error(error.message); process.exit(1); }
}

// Run as a script (not imported by the tests). Windows paths can differ in case, e.g. the drive letter.
const self = fileURLToPath(import.meta.url), ran = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.platform === "win32" ? self.toLowerCase() === ran.toLowerCase() : self === ran) await main();
