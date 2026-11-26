// Why a clip was rejected, picked in the dashboard right after rejecting it (Clips, and swipe review). Stored as
// clips.reject_reason and summed for the last 30 days, to see which part of clipping lets people down most.
export const REJECT_REASONS = { boring: "Boring moment", context: "Missing context", subtitles: "Bad subtitles", framing: "Wrong framing" };
export const REJECT_REASON_KEYS = Object.keys(REJECT_REASONS);
export const REJECT_WINDOW_DAYS = 30;
