// Text styles: the subtitle and opening title look on its own (fonts, colours, sizes, bold/italic/shadow, alignment,
// animation, where the title sits), without what belongs to one clip: whether each is switched on, the subtitles'
// height (it follows the framing), the title's text and its per-line formatting. A workspace keeps saved ones
// (text_styles) to apply to clips; one can also be exported to a .json file and imported again.
import { defaultStyle, normalizeStyle, styleOf, withTextStyle } from "./edit.mjs";

export const TEXT_STYLE_KIND = "clipflow-text-style", TEXT_STYLE_VERSION = 1, MAX_TEXT_STYLE_BYTES = 16384, MAX_TEXT_STYLES = 50;
const CAPTION_SKIP = new Set(["on", "y"]), HOOK_SKIP = new Set(["on", "text", "lines"]);
const omit = (o, skip) => Object.fromEntries(Object.entries(o).filter(([k]) => !skip.has(k)));
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

/** The text style of an edit or a look: { captions, hook } without the clip's own parts. */
export function textStyleOf(editOrStyle) {
  const s = normalizeStyle(editOrStyle);
  return { captions: omit(s.captions, CAPTION_SKIP), hook: omit(s.hook, HOOK_SKIP) };
}

/**
 * A text style from an untrusted source (a saved row, a request, an imported file), checked like an edit and with
 * anything missing filled from the defaults. Throws with a readable message.
 */
export function readTextStyle(input) {
  if (!isObj(input) || (input.captions !== undefined && !isObj(input.captions)) || (input.hook !== undefined && !isObj(input.hook))) throw new Error("This isn't a text style");
  const base = defaultStyle();
  return textStyleOf({ ...base, captions: { ...base.captions, ...input.captions }, hook: { ...base.hook, ...input.hook } });
}

/** `edit` in a text style: its subtitle and title look replaced, its switches, title text and line formatting kept. */
export function applyTextStyle(edit, style) {
  const t = readTextStyle(style);
  return withTextStyle(edit, { ...styleOf(edit), captions: { ...edit.captions, ...t.captions }, hook: { ...edit.hook, ...t.hook } });
}

/** A saved style's name: 1 to 40 characters on one line. */
export function styleName(v) {
  const name = typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (!name) throw new Error("Give the style a name");
  return name;
}

/** A .json file for a text style, to keep or share. */
export function toTemplateFile(style, name) {
  return JSON.stringify({ kind: TEXT_STYLE_KIND, v: TEXT_STYLE_VERSION, name: styleName(name), ...readTextStyle(style) }, null, 2) + "\n";
}

/** A text style from an exported file's text: { name, style }. Throws with a readable message. */
export function readTemplateFile(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT_STYLE_BYTES) throw new Error("That file is too big to be a text style");
  let v;
  try { v = JSON.parse(text); } catch { throw new Error("That file isn't a ClipFlow text style"); }
  if (!isObj(v) || v.kind !== TEXT_STYLE_KIND) throw new Error("That file isn't a ClipFlow text style");
  if (!Number.isInteger(v.v) || v.v > TEXT_STYLE_VERSION) throw new Error("That text style was made by a newer ClipFlow");
  let name;
  try { name = styleName(v.name); } catch { name = "Imported style"; }
  return { name, style: readTextStyle({ captions: v.captions, hook: v.hook }) };
}
