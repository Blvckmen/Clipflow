// Library thumbnails: a small JPEG still of each clip, taken by the browser the first time the clip is shown (it
// already has the video loaded then) and stored in R2, so the gallery shows images instead of opening one video per
// card. The key carries the clip's edit revision: an edited clip gets a new thumbnail once its new version is shown.
export const THUMB_MAX_BYTES = 200_000;
export const thumbKey = (owner: string, clipId: string, rev: number) => `thumbs/${owner}/${clipId}-${rev}.jpg`;
// The thumbnail object of a clip row, if it has one, for deleting it with the clip.
export const thumbOf = (owner: string, row: { id: string; thumb_rev: number | null }) => (row.thumb_rev == null ? null : thumbKey(owner, row.id, row.thumb_rev));
