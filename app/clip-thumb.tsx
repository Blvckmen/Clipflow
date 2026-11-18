"use client";
import { useEffect, useRef, useState } from "react";
// A clip card's picture. Clips with a saved thumbnail show it as an image and only load the video while hovered;
// clips without one load their video once it scrolls into view, show the frame at one second and save that frame as
// the thumbnail (so the next visit shows the image). Off-screen cards load nothing.
type ThumbClip = { id: string; edit_rev: number; thumb_rev?: number | null; render_state: string | null };
// Clips whose thumbnail this page already tried to save (successful or not), so a failure isn't retried in a loop.
const tried = new Set<string>();
const THUMB_WIDTH = 360;

async function saveThumb(video: HTMLVideoElement, clip: ThumbClip) {
  const key = clip.id + ":" + clip.edit_rev;
  if (tried.has(key) || !video.videoWidth) return false;
  tried.add(key);
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH; canvas.height = Math.round(THUMB_WIDTH * video.videoHeight / video.videoWidth);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/jpeg", 0.75));
  if (!blob) return false;
  const response = await fetch("/api/clips/" + clip.id + "/thumb?rev=" + clip.edit_rev, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).catch(() => null);
  return !!response?.ok;
}

export function ClipThumb({ clip }: { clip: ThumbClip }) {
  const box = useRef<HTMLSpanElement>(null), video = useRef<HTMLVideoElement>(null);
  const [seen, setSeen] = useState(false), [hover, setHover] = useState(false);
  const src = "/api/clips/" + clip.id + "/file?v=" + clip.edit_rev;
  const hasThumb = clip.thumb_rev === clip.edit_rev;
  useEffect(() => {
    const el = box.current;
    if (!el || seen || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setSeen(true); watch.disconnect(); } }, { rootMargin: "300px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen]);
  // Hover plays the clip, muted: the video that is already there, or one laid over the thumbnail image.
  useEffect(() => {
    const v = video.current;
    if (!v || hasThumb) return;
    if (hover) void v.play().catch(() => {}); else { v.pause(); if (v.readyState) v.currentTime = Math.min(1, v.duration / 3 || 0); }
  }, [hover, hasThumb]);
  return <span ref={box} className="thumb-media" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    {hasThumb
      ? <>
          <img src={"/api/clips/" + clip.id + "/thumb?v=" + clip.thumb_rev} alt="" loading="lazy" decoding="async" />
          {hover && <video className="thumb-hover" src={src} muted playsInline autoPlay loop preload="auto" />}
        </>
      : seen && <video ref={video} src={src} muted playsInline loop preload="metadata"
          onLoadedMetadata={e => { e.currentTarget.currentTime = Math.min(1, e.currentTarget.duration / 3 || 0); }}
          onSeeked={e => { if (clip.render_state !== "queued") void saveThumb(e.currentTarget, clip); }} />}
  </span>;
}
