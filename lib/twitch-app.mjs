// What a worker may ask the dashboard's Twitch app (app/api/worker/twitch): the three Helix lookups viewers' clips use
// (worker/twitch.mjs), with only the parameters they send, each checked. Anything else is refused.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RULES = {
  users: { login: { re: /^[a-z0-9_]{2,25}$/, max: 1, need: true } },
  clips: { broadcaster_id: { re: /^\d{1,20}$/, max: 1, need: true }, started_at: { re: ISO, max: 1 }, ended_at: { re: ISO, max: 1 }, first: { re: /^(?:[1-9]|[1-9]\d|100)$/, max: 1 } },
  videos: { id: { re: /^\d{1,20}$/, max: 100, need: true } },
};

/** { resource, params } for a worker's request (search params with "resource" plus Helix's own), or null if not allowed. */
export function helixQuery(search) {
  const resource = search.get("resource"), rules = Object.hasOwn(RULES, resource ?? "") ? RULES[resource] : null;
  if (!rules) return null;
  const params = new URLSearchParams();
  for (const [key, value] of search) {
    if (key === "resource") continue;
    const rule = Object.hasOwn(rules, key) ? rules[key] : null;
    if (!rule || !rule.re.test(value) || params.getAll(key).length >= rule.max) return null;
    params.append(key, value);
  }
  for (const [key, rule] of Object.entries(rules)) if (rule.need && !params.has(key)) return null;
  return { resource, params };
}
