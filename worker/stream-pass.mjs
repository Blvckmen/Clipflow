// The full pass after a stream: once a recording's whole transcript exists (transcript search), the AI reads it in
// clip-length windows and scores each, so stories, jokes and reveals that neither chat nor loudness flagged still
// reach the pick list (and, for record-only streams, become clips). Pure helpers; main.mjs runs the pass.

export const AI_BATCH = 6, AI_AUTO_CLIP = 8, AI_SUGGEST = 6;

/**
 * The transcript in back-to-back windows of `duration` seconds (from `skip`), each with what was said in it.
 * Windows with almost nothing said (under 8 words) are left out: there's nothing for the AI to judge.
 * @param {[number, number, string][]} lines [start, end, text] in seconds
 */
export function transcriptWindows(lines, { duration, total, skip = 0 }) {
  const out = [];
  for (let start = Math.max(0, skip); start + duration <= total + 1; start += duration) {
    const end = Math.min(total, start + duration);
    const text = (lines ?? []).filter(l => l[1] > start && l[0] < end).map(l => String(l[2]).trim()).join(" ").replace(/\s+/g, " ").trim();
    if (text.split(" ").length >= 8) out.push({ start: Math.round(start), end: Math.round(end), text: text.slice(0, 900) });
  }
  return out;
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.max(1, Math.min(a.end - a.start, b.end - b.start));

/**
 * The pick list with the AI's opinion in it. `existing`: suggested moments from loudness, chat and on-screen text
 * ({ start, end, score 0-1, why[] }). `rated`: the AI's windows ({ start, end, score 0-10, title }). An existing moment
 * the AI also liked gets its title as a reason and a higher place; windows the AI rated `minScore`+ that nothing else
 * flagged are added on their own (the quiet moments). Best first, at most `count`, no two overlapping by half.
 */
export function mergeAiMoments(existing, rated, { count = 12, minScore = AI_SUGGEST } = {}) {
  const liked = (rated ?? []).filter(r => Number.isFinite(r.score) && r.score >= minScore);
  const merged = (existing ?? []).map(m => {
    const ai = liked.filter(r => overlap(m, r) >= 0.5).sort((a, b) => b.score - a.score)[0];
    const why = ai ? ["AI: " + ai.title, ...m.why.filter(w => !w.startsWith("AI: "))].slice(0, 4) : m.why;
    return { ...m, why, value: m.score * 0.5 + (ai ? ai.score / 10 : 0) * 0.5 };
  });
  for (const r of liked) {
    if (merged.some(m => overlap(m, r) >= 0.5)) continue;
    // Only the AI saw it: placed by its rating alone (a 9 ranks like a moment with strong signals and a decent rating).
    merged.push({ start: r.start, end: r.end, score: 0, why: ["AI: " + r.title], value: r.score / 10 * 0.75 });
  }
  merged.sort((a, b) => b.value - a.value || a.start - b.start);
  const chosen = [];
  for (const m of merged) { if (chosen.length >= count) break; if (chosen.every(c => overlap(c, m) < 0.5)) chosen.push(m); }
  const top = chosen[0]?.value || 1;
  return chosen.map(({ value, ...m }) => ({ ...m, score: Math.round((value / top) * 100) / 100 }));
}

/** The AI's best windows (rated `minScore`+) that don't overlap anything already clipped from the recording, best first. */
export function autoClipPicks(rated, clipped, { minScore = AI_AUTO_CLIP, max = 5 } = {}) {
  return (rated ?? []).filter(r => Number.isFinite(r.score) && r.score >= minScore && (clipped ?? []).every(c => overlap(c, r) < 0.3))
    .sort((a, b) => b.score - a.score || a.start - b.start).slice(0, Math.max(0, max));
}
