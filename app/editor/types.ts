// The clip editor's data: the saved edit (validated by worker/edit.mjs normalizeEdit) and what GET
// /api/clips/[id]/edit sends with it.
import type { ASPECTS } from "../../worker/edit.mjs";

export type Split = { share: number; top: "stream" | "background"; divider: string | null; volume: number };
export type CamBox = { x: number; y: number; w: number; h: number };
export type Facecam = { box: CamBox | null; share: number; corner: "tl" | "tr" | "bl" | "br"; size: number; place?: "top" | "bottom"; shape?: "box" | "circle" };
export type Aspect = keyof typeof ASPECTS;
export type Frame = { mode: "blur" | "crop" | "fit" | "split" | "cam" | "pip" | "phone"; aspect?: Aspect; content?: CamBox | null; zoom: number; x: number; y: number; background?: string | null; split?: Split; facecam?: Facecam };
export type Captions = { on: boolean; preset: string; font: string; size: number; color: string; highlight: string; outline: number; outlineColor: string; box: boolean; boxColor: string; uppercase: boolean; animation: string; words: number; y: number; mask: boolean; keywords: boolean; keywordColor: string; bold?: boolean; italic?: boolean; shadow?: number; align?: string };
export type Word = [number, number, string];
export type Hook = { on?: boolean; text: string; seconds: number; color: string; bg: string | null; x: number; y: number; size: number; own?: boolean; font?: string; bold?: boolean; italic?: boolean; shadow?: number; uppercase?: boolean; align?: string; anim?: "pop" | "fade" | "none"; lines?: ({ color?: string; size?: number } | null)[] };
export type ChatLook = { on: boolean; y: number };
export type Pace = { cuts: "off" | "gentle" | "tight"; zooms: boolean };
export type Speaker = { at: number; name: string };
export type Edit = { v: number; trim: { start: number; end: number }; frame: Frame; look: { brightness: number; contrast: number; saturation: number }; captions: Captions; hook: Hook; progress: { on: boolean; color: string }; pace?: Pace; chat?: ChatLook; audio?: { music: "keep" | "lower" | "voice" }; words?: Word[]; speakers?: Speaker[] };
// [seconds into the source, name, text, colour]: the Twitch chat sent during the clip's source.
export type ChatMessage = [number, string, string, string | null];
export type Bundle = { id: string; streamerId: string; streamer: string | null; edit: Edit; rev: number; words: Word[]; signals: { energy: number[]; chat: number[]; messages?: ChatMessage[] } | null; source: { width: number; height: number; duration: number; face?: CamBox | null; content?: CamBox | null }; legacy: boolean; sourceStored: boolean; pruned?: string | null; render: { state: string | null; error: string | null; at: string | null }; review?: string; createdAt: string; caption: { text: string | null; source: string | null; error: string | null; ai: boolean } };
export type Step = "cut" | "text" | "extras" | "review";
export const STEPS: { id: Step; label: string }[] = [{ id: "cut", label: "Cut & frame" }, { id: "text", label: "Text" }, { id: "extras", label: "Extras" }, { id: "review", label: "Review & post" }];
// Every change to the edit goes through `change`: the same key within 600 ms is one undo step (a slider drag).
export type Change = (key: string, next: (e: Edit) => Edit) => void;
export type Box = { left: number; right: number; top: number; bottom: number };
// The finished clip's timeline (worker/edit.mjs timeline): jump cuts [from, to] in trimmed-source seconds, punch-ins.
export type ClipTimeline = { cuts: number[][]; punches: number[]; length: number; toClip: (t: number) => number };
// The edit's setters every step uses (ClipEditor makes them from `change`).
export type Tools = {
  change: Change;
  set: <K extends "frame" | "look" | "hook" | "progress">(key: K, value: Partial<Edit[K]>) => void;
  setCaption: (value: Partial<Captions>) => void;
  setSplit: (value: Partial<Split>) => void;
};

// Sets the preview video's time, speed or sound (the steps get the video element from ClipEditor).
export function setMedia(v: HTMLVideoElement | null | undefined, values: Partial<Pick<HTMLVideoElement, "currentTime" | "playbackRate" | "muted">>) {
  if (v) Object.assign(v, values);
}

export const fmt =(t: number) => Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0");
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
