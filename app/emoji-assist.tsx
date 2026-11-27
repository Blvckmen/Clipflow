"use client";
// One emoji button for every place you type: it appears in the corner of whichever text box or text area has focus
// and inserts at the cursor, so new fields get it without any wiring. Fields where an emoji makes no sense (links,
// numbers, times, hashtags, keys) are skipped by type or with data-emoji="off" on the field or a parent.
import { useCallback, useEffect, useRef, useState } from "react";

const GROUPS: [string, string][] = [
  ["😀", "😂 🤣 😭 😅 😆 😁 😀 😊 😇 🙂 😉 😍 🥰 😘 😎 🤩 🥳 😏 😬 🙃 🤔 🤨 😐 😑 😶 🙄 😮 😯 😲 😱 😳 🥺 😢 😤 😠 😡 🤬 🤯 😴 🤤 🤢 🤮 🥵 🥶 😈 💀 ☠️ 🤡 👻 👽 🤖 💩 🫠 🫡 🫣 🤫 🤭 🥲 😵 😵‍💫"],
  ["🔥", "🔥 💯 ⚡ 🚀 💥 ✨ 🎉 🎊 🏆 🥇 👑 💎 💰 💸 🎯 🎮 🕹️ 👾 🎧 🎤 🎬 📺 📹 🎥 📸 🔴 🟢 ⏰ ⏱️ 📈 📉 🔔 📣 📢 💬 💭 🗣️ 👀 🧠 💪 🦾 🐐 🍿 🥶 🧊 🌶️"],
  ["👍", "👍 👎 👏 🙌 🤝 🙏 👊 ✊ 🤛 🤜 ✌️ 🤞 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💅 🫶 🫵 ✍️"],
  ["❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝"],
  ["⭐", "⭐ 🌟 💫 ☀️ 🌙 🌈 ☁️ ⛈️ ❄️ 🌊 🌴 🌹 🌸 🍀 🐶 🐱 🐸 🐵 🦁 🐺 🦊 🐻 🐼 🐔 🦅 🦈 🐍 🐉 🦄"],
  ["🍕", "🍕 🍔 🍟 🌭 🌮 🍗 🍜 🍣 🍩 🍪 🎂 🍫 🍦 🍉 🍓 🍌 🥑 ☕ 🧋 🥤 🍺 🍻 🥂 🍾"],
  ["⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🥊 🥋 ⛳ 🏁 🏎️ 🚗 ✈️ 🛸 🏠 🎲 ♟️ 🎳 🎰 🧩"],
  ["✅", "✅ ❌ ❗ ❓ ‼️ ⁉️ ⚠️ 🚫 ⛔ 💤 🆕 🆒 🆓 🔝 🔜 ➡️ ⬅️ ⬆️ ⬇️ ↩️ 🔁 ▶️ ⏸️ ⏹️ 🔊 🔇 #️⃣ 💲 ™️ ©️"],
];
const LABELS = ["Faces", "Hype", "Hands", "Hearts", "Nature", "Food", "Play", "Symbols"];
const RECENT_KEY = "clipflow:recent-emoji";

function readRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string").slice(0, 24) : []; } catch { return []; }
}
function saveRecent(list: string[]) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private mode */ } }

type Field = HTMLInputElement | HTMLTextAreaElement;
export function typable(el: EventTarget | null): el is Field {
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false;
  if (el.readOnly || el.disabled || el.closest('[data-emoji="off"]')) return false;
  if (el instanceof HTMLInputElement && el.type !== "text") return false;
  return !["numeric", "decimal", "tel", "url", "email", "none"].includes(el.inputMode);
}

// Typing through the browser keeps undo working and lets React see the change; the setter is the fallback.
function insert(field: Field, text: string) {
  const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
  const next = field.value.slice(0, start) + text + field.value.slice(end);
  if (field.maxLength > 0 && next.length > field.maxLength) return false;
  field.focus();
  field.setSelectionRange(start, end);
  if (!document.execCommand?.("insertText", false, text) || field.value !== next) {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, next);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  field.setSelectionRange(start + text.length, start + text.length);
  return true;
}

export default function EmojiAssist() {
  const [field, setField] = useState<Field | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [box, setBox] = useState<DOMRect | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const place = useCallback(() => setBox(field?.isConnected ? field.getBoundingClientRect() : null), [field]);

  useEffect(() => {
    const focusIn = (e: FocusEvent) => { if (typable(e.target)) { setField(e.target); } else if (!root.current?.contains(e.target as Node)) { setField(null); setOpen(false); } };
    const focusOut = (e: FocusEvent) => { if (!e.relatedTarget || !root.current?.contains(e.relatedTarget as Node)) setTimeout(() => { if (!typable(document.activeElement)) { setField(null); setOpen(false); } }, 0); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(o => { if (o) e.stopPropagation(); return false; }); };
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("focusin", focusIn); document.removeEventListener("focusout", focusOut); document.removeEventListener("keydown", key, true); };
  }, []);

  useEffect(() => {
    place();
    if (!field) return;
    field.classList.add("has-emoji");
    const observer = new ResizeObserver(place);
    observer.observe(field);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { field.classList.remove("has-emoji"); observer.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [field, place]);

  useEffect(() => { if (open) setRecent(readRecent()); }, [open]);

  if (!field || !box || box.width < 60 || box.bottom < 0 || box.top > window.innerHeight) return null;
  const area = field instanceof HTMLTextAreaElement;
  const size = 26, left = box.right - size - 4, top = area ? box.top + 4 : box.top + (box.height - size) / 2;
  const width = Math.min(320, window.innerWidth - 32);
  const below = window.innerHeight - box.bottom > 320 || box.top < 320;
  const panel = { left: Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16)), width, ...(below ? { top: box.bottom + 6 } : { bottom: window.innerHeight - box.top + 6 }) };
  const list = tab < 0 ? recent : GROUPS[tab][1].split(" ");
  const pick = (emoji: string) => {
    if (!insert(field, emoji)) return;
    const next = [emoji, ...readRecent().filter(x => x !== emoji)].slice(0, 24);
    saveRecent(next); setRecent(next);
  };
  // Pressing inside never takes focus from the field, so the cursor stays where it was.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return <div ref={root} className="emoji-assist" onPointerDown={keep} onMouseDown={keep}>
    <button type="button" tabIndex={-1} className={"emoji-toggle" + (open ? " on" : "")} style={{ left, top, width: size, height: size }} aria-label={open ? "Close emoji" : "Add an emoji"} aria-expanded={open} title="Add an emoji" onClick={() => setOpen(!open)}>😊</button>
    {open && <div className="emoji-panel" role="dialog" aria-label="Emoji" style={panel}>
      <div className="emoji-tabs" role="tablist">
        {recent.length > 0 && <button type="button" tabIndex={-1} role="tab" aria-selected={tab < 0} className={tab < 0 ? "on" : ""} title="Recent" onClick={() => setTab(-1)}>🕘</button>}
        {GROUPS.map(([icon], i) => <button key={icon} type="button" tabIndex={-1} role="tab" aria-selected={tab === i} className={tab === i ? "on" : ""} title={LABELS[i]} onClick={() => setTab(i)}>{icon}</button>)}
      </div>
      <div className="emoji-grid">
        {list.map(e => <button key={e} type="button" tabIndex={-1} aria-label={"Insert " + e} onClick={() => pick(e)}>{e}</button>)}
      </div>
    </div>}
  </div>;
}
