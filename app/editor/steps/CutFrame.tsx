"use client";
// Step 1, Cut & frame: where the clip starts and ends, its shape, its template and the template's own settings.
import type { RefObject } from "react";
import { ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import { ASPECTS, ASPECT_LABELS, DEFAULT_FACECAM, DEFAULT_SPLIT, camAreas, canvas as frameSize, captionSeat, multiAreas, stacks, templateOf } from "../../../worker/edit.mjs";
import { More } from "../More";
import { TemplateGallery } from "../TemplateGallery";
import { BoxPicker } from "../BoxPicker";
import { boxesOf, setBox, withStartingBoxes } from "../boxes";
import { backgroundChoice, secs, type BgClip, type BgVideo } from "../backgrounds";
import { clamp, fmt, type Aspect, type Bundle, type CamBox, type Edit, type Facecam, type Frame, type Split, type Tools } from "../types";

// The layouts that stack pictures, which a landscape clip has no room for.
export const STACKED: string[] = ["split", "cam", "duo", "duostack", "squad"];

export function CutFrame({ bundle, edit, tools, video, time, setTrim, backgrounds, bgClips }: {
  bundle: Bundle; edit: Edit; tools: Tools; video: RefObject<HTMLVideoElement | null>; time: number; setTrim: (which: "start" | "end", t: number) => void; backgrounds: BgVideo[]; bgClips: BgClip[];
}) {
  const { change, set, setSplit } = tools, aspect = (edit.frame.aspect ?? "9:16") as Aspect;
  const bg = backgroundChoice(edit, backgrounds, bgClips);
  return <>
    <div className="trim-row">
      <button type="button" className="secondary" title="Start the clip here (I)" onClick={() => setTrim("start", time)}><ArrowLeftToLine size={15} />Start here</button>
      <span className="trim-readout">{fmt(edit.trim.start)} – {fmt(edit.trim.end)}</span>
      <button type="button" className="secondary" title="End the clip here (O)" onClick={() => setTrim("end", time)}>End here<ArrowRightToLine size={15} /></button>
    </div>
    <label className="wide">Shape<div className="segmented aspect-picker">{(Object.keys(ASPECTS) as Aspect[]).map(a => <button key={a} type="button" className={aspect === a ? "active" : ""} title={ASPECT_LABELS[a]} onClick={() => change("frame-aspect", e => {
      // A landscape clip can't stack two pictures: split screen and facecam-on-top become the blurred fill there.
      const frame = { ...e.frame, aspect: a }, flat = !stacks(frame) && STACKED.includes(e.frame.mode);
      return { ...e, frame: flat ? { ...frame, mode: "blur" } : frame, captions: flat ? { ...e.captions, y: 0.72 } : e.captions };
    })}><span className={"aspect-icon a" + a.replace(":", "x")} aria-hidden />{a}</button>)}</div>
      <small>{aspect === "9:16" ? "TikTok, Reels and Shorts." : aspect === "16:9" ? "YouTube videos and X." : "Instagram and Facebook feeds."}</small></label>
    <TemplateGallery video={video} frame={edit.frame} face={bundle.source.face ?? null} active={templateOf(edit.frame)} onPick={t => change("frame-mode", e => {
      const m = t.mode as Frame["mode"];
      const facecam = { ...DEFAULT_FACECAM, ...e.frame.facecam, ...("facecam" in t ? t.facecam : {}) } as Facecam;
      if ((m === "cam" || m === "pip") && !facecam.box) facecam.box = bundle.source.face ?? null;
      const content = m === "phone" && !e.frame.content ? bundle.source.content ?? null : e.frame.content ?? null;
      // The templates that need the clip's own boxes start with sensible ones (placed below in the box picker).
      const frame = withStartingBoxes({ ...e.frame, mode: m, facecam, content, ...("frame" in t ? t.frame : {}) } as Frame, bundle.source.face);
      // Subtitles follow the layout's own spot (a seam, or low in the game), unless they were moved somewhere else.
      const atSeat = Math.abs(e.captions.y - 0.72) < 0.01 || Math.abs(e.captions.y - captionSeat(e.frame)) < 0.01;
      return { ...e, frame, captions: atSeat ? { ...e.captions, y: captionSeat(frame) } : e.captions };
    })} />
    {boxesOf(edit.frame).length > 0 && <div className="facecam-controls">
      <small>{multiAreas(edit.frame) ? "Drag each box onto a person. Drag a corner to resize." : edit.frame.mode === "gameui" ? "Drag the purple box onto the scoreboard, minimap or kill feed." : "Drag the box onto the webcam."}</small>
      <BoxPicker video={video} boxes={boxesOf(edit.frame)} onChange={(key, box) => change("box-" + key, e => ({ ...e, frame: setBox(e.frame, key, box) }))} />
      {edit.frame.mode === "gameui" && <label className="switch-row"><input type="checkbox" checked={!!edit.frame.uiCam} onChange={ev => { const on = ev.target.checked; change("frame-uicam", e => ({ ...e, frame: withStartingBoxes({ ...e.frame, uiCam: on }, bundle.source.face) })); }} />Webcam in a corner</label>}
    </div>}
    {edit.frame.mode === "phone" && <PhoneBox bundle={bundle} edit={edit} tools={tools} />}
    {(edit.frame.mode === "cam" || edit.frame.mode === "pip") && <Webcam bundle={bundle} edit={edit} tools={tools} />}
    {edit.frame.mode === "split" && <>
      <label className="wide">Background
        <select value={edit.frame.background ?? ""} onChange={e => set("frame", { background: e.target.value || null })}>
          <option value="">Picked from your library</option>
          {bg.fitLibrary.length > 0 && <optgroup label="Background library">{bg.fitLibrary.map(b => <option key={b.id} value={b.id}>{b.name}{b.content_type?.startsWith("image/") ? " · image" : b.duration ? " · " + secs(b.duration) : ""}</option>)}</optgroup>}
          {bg.fitClips.length > 0 && <optgroup label="Your clips">{bg.fitClips.map(c => <option key={c.id} value={"clip:" + c.id}>{(c.streamer ?? "Clip") + " · " + secs(c.duration) + " · " + new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</option>)}</optgroup>}
          {bg.chosenTooShort && <option value={edit.frame.background!}>Chosen video (too short now)</option>}
        </select>
        <small>{bg.chosenTooShort ? "Shorter than this clip now: pick another." : bg.fitLibrary.length + bg.fitClips.length ? (bg.hiddenShort ? bg.hiddenShort + " shorter than " + secs(bg.len) + " hidden." : "") : "Nothing long enough: upload longer loops in Settings."}</small></label>
      {(() => { const sp = { ...DEFAULT_SPLIT, ...edit.frame.split } as Split; return <div className="control-grid">
        <label>Stream size<select value={sp.share} onChange={e => setSplit({ share: Number(e.target.value) })}>
          {[[0.5, "Half and half"], [0.6, "Stream 60%"], [0.7, "Stream 70%"], [0.8, "Stream 80%"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {![0.5, 0.6, 0.7, 0.8].includes(sp.share) && <option value={sp.share}>Stream {Math.round(sp.share * 100)}%</option>}</select></label>
        <label>Stream position<select value={sp.top} onChange={e => setSplit({ top: e.target.value as Split["top"] })}><option value="stream">On top</option><option value="background">At the bottom</option></select></label>
        <label>Divider line<div className="color-pair"><input type="checkbox" checked={!!sp.divider} onChange={e => setSplit({ divider: e.target.checked ? "#ffffff" : null })} />{sp.divider && <input type="color" value={sp.divider} onChange={e => setSplit({ divider: e.target.value })} />}</div></label>
        <label>Background sound <span>{bg.previewIsImage ? "image" : Math.round(sp.volume * 100) + "%"}</span><input type="range" min={0} max={1} step={0.05} value={sp.volume} disabled={bg.previewIsImage} onChange={e => setSplit({ volume: Number(e.target.value) })} /></label>
      </div>; })()}
    </>}
    <label>Zoom <span>{edit.frame.zoom.toFixed(2)}×</span><input type="range" min={1} max={3} step={0.01} value={edit.frame.zoom} onChange={e => set("frame", { zoom: Number(e.target.value) })} /></label>
    <More>
      <div className="control-grid">
        <label>Left / right <span>{Math.round(edit.frame.x * 100)}</span><input type="range" min={-1} max={1} step={0.01} value={edit.frame.x} onChange={e => set("frame", { x: Number(e.target.value) })} /></label>
        <label>Up / down <span>{Math.round(edit.frame.y * 100)}</span><input type="range" min={-1} max={1} step={0.01} value={edit.frame.y} onChange={e => set("frame", { y: Number(e.target.value) })} /></label>
        <label>Brightness <span>{Math.round(edit.look.brightness * 100)}%</span><input type="range" min={0.5} max={1.5} step={0.01} value={edit.look.brightness} onChange={e => set("look", { brightness: Number(e.target.value) })} /></label>
        <label>Contrast <span>{Math.round(edit.look.contrast * 100)}%</span><input type="range" min={0.5} max={1.5} step={0.01} value={edit.look.contrast} onChange={e => set("look", { contrast: Number(e.target.value) })} /></label>
        <label>Saturation <span>{Math.round(edit.look.saturation * 100)}%</span><input type="range" min={0} max={2} step={0.01} value={edit.look.saturation} onChange={e => set("look", { saturation: Number(e.target.value) })} /></label>
      </div>
      <button className="secondary" onClick={() => change("reset-frame", e => ({ ...e, frame: { ...e.frame, zoom: 1, x: 0, y: 0 }, look: { brightness: 1, contrast: 1, saturation: 1 } }))}>Reset framing and colour</button>
    </More>
  </>;
}

// The phone picture's edges in the stream (fractions). Without one, an upright picture in the middle.
function PhoneBox({ bundle, edit, tools }: { bundle: Bundle; edit: Edit; tools: Tools }) {
  const sw = bundle.source.width || 1280, sh = bundle.source.height || 720, auto = Math.min(1, (sh * 9 / 16) / sw);
  const b = edit.frame.content ?? { x: (1 - auto) / 2, y: 0, w: auto, h: 1 };
  const setContent = (value: Partial<CamBox> | null) => tools.change("frame-content" + (value ? Object.keys(value).join() : ""), e => {
    if (!value) return { ...e, frame: { ...e.frame, content: null } };
    const nb = { ...b, ...value }; nb.w = clamp(nb.w, 0.05, 1); nb.h = clamp(nb.h, 0.05, 1); nb.x = clamp(nb.x, 0, 1 - nb.w); nb.y = clamp(nb.y, 0, 1 - nb.h);
    return { ...e, frame: { ...e.frame, content: nb } };
  });
  const found = bundle.source.content, usingFound = !!found && edit.frame.content === found;
  return <div className="facecam-controls">
    <small>{usingFound ? "Phone picture found. " : edit.frame.content ? "" : "Upright picture in the middle. "}Fit the edges to the phone picture.
      {found && !usingFound && <> <button type="button" className="text-button" onClick={() => setContent(found)}>Use the detected one</button></>}
      {edit.frame.content && <> <button type="button" className="text-button" onClick={() => setContent(null)}>Centre it</button></>}</small>
    <More label="Edges">
      <div className="control-grid">
        <label>Left <span>{Math.round(b.x * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b.x} onChange={e => setContent({ x: Number(e.target.value) })} /></label>
        <label>Width <span>{Math.round(b.w * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b.w} onChange={e => setContent({ w: Number(e.target.value) })} /></label>
        <label>Top <span>{Math.round(b.y * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b.y} onChange={e => setContent({ y: Number(e.target.value) })} /></label>
        <label>Height <span>{Math.round(b.h * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b.h} onChange={e => setContent({ h: Number(e.target.value) })} /></label>
      </div>
    </More>
  </div>;
}

// The webcam box (fractions of the stream) and how the facecam template shows it.
function Webcam({ bundle, edit, tools }: { bundle: Bundle; edit: Edit; tools: Tools }) {
  const fc = { ...DEFAULT_FACECAM, ...edit.frame.facecam } as Facecam, b = fc.box;
  const setCam = (value: Partial<Facecam>) => tools.change("frame-facecam" + Object.keys(value).join(), e => {
    const facecam = { ...DEFAULT_FACECAM, ...e.frame.facecam, ...value } as Facecam;
    const moved = value.share !== undefined && e.frame.mode === "cam";
    return { ...e, frame: { ...e.frame, facecam }, captions: moved ? { ...e.captions, y: camAreas({ ...e.frame, facecam }).seam / frameSize(e.frame).H } : e.captions };
  });
  const setBox = (value: Partial<CamBox>) => { const nb = { ...(b ?? { x: 0, y: 0, w: 0.3, h: 0.4 }), ...value }; nb.w = clamp(nb.w, 0.05, 1); nb.h = clamp(nb.h, 0.05, 1); nb.x = clamp(nb.x, 0, 1 - nb.w); nb.y = clamp(nb.y, 0, 1 - nb.h); setCam({ box: nb }); };
  return <div className="facecam-controls">
    {bundle.source.face && b !== bundle.source.face && <small><button type="button" className="text-button" onClick={() => setCam({ box: bundle.source.face! })}>Use the detected webcam</button></small>}
    <div className="control-grid">
      {edit.frame.mode === "cam" ? <label>Webcam strip <span>{Math.round(fc.share * 100)}%</span><input type="range" min={0.2} max={0.5} step={0.01} value={fc.share} onChange={e => setCam({ share: Number(e.target.value) })} /></label>
        : <><label>Corner<select value={fc.corner} onChange={e => setCam({ corner: e.target.value as Facecam["corner"] })}><option value="tl">Top left</option><option value="tr">Top right</option><option value="bl">Bottom left</option><option value="br">Bottom right</option></select></label>
          <label>Size <span>{Math.round(fc.size * 100)}%</span><input type="range" min={0.2} max={0.5} step={0.01} value={fc.size} onChange={e => setCam({ size: Number(e.target.value) })} /></label></>}
    </div>
    <More label="Webcam box">
      <div className="control-grid">
        <label>Left <span>{Math.round((b?.x ?? 0) * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b?.x ?? 0} onChange={e => setBox({ x: Number(e.target.value) })} /></label>
        <label>Top <span>{Math.round((b?.y ?? 0) * 100)}%</span><input type="range" min={0} max={0.95} step={0.005} value={b?.y ?? 0} onChange={e => setBox({ y: Number(e.target.value) })} /></label>
        <label>Width <span>{Math.round((b?.w ?? 0.3) * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b?.w ?? 0.3} onChange={e => setBox({ w: Number(e.target.value) })} /></label>
        <label>Height <span>{Math.round((b?.h ?? 0.4) * 100)}%</span><input type="range" min={0.05} max={1} step={0.005} value={b?.h ?? 0.4} onChange={e => setBox({ h: Number(e.target.value) })} /></label>
        {edit.frame.mode === "cam" && <label>Divider line<div className="color-pair"><input type="checkbox" checked={!!edit.frame.split?.divider} onChange={e => tools.setSplit({ divider: e.target.checked ? "#ffffff" : null })} />{edit.frame.split?.divider && <input type="color" value={edit.frame.split.divider} onChange={e => tools.setSplit({ divider: e.target.value })} />}</div></label>}
      </div>
    </More>
  </div>;
}
