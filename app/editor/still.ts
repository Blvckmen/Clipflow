"use client";
// A still of the preview video's current frame (at most 640 wide), taken again whenever the video moves to another
// frame, for the template gallery and the box picker.
import { type RefObject, useEffect, useState } from "react";

export function useStill(video: RefObject<HTMLVideoElement | null>) {
  const [still, setStill] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const take = () => {
      if (v.readyState < 2 || !v.videoWidth) return;
      const c = document.createElement("canvas"), s = Math.min(1, 640 / v.videoWidth);
      c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height); setStill(c);
    };
    // After a seek the new frame may not be decoded yet when the event fires (it comes out black): take it again a
    // little later too.
    let live = true;
    const later = () => { take(); for (const ms of [200, 800]) setTimeout(() => { if (live) take(); }, ms); };
    later();
    for (const ev of ["loadeddata", "seeked", "pause"]) v.addEventListener(ev, later);
    return () => { live = false; for (const ev of ["loadeddata", "seeked", "pause"]) v.removeEventListener(ev, later); };
  }, [video]);
  return still;
}
