"use client";
import { useRef, useState } from "react";
import { Check, Copy, Loader2, Sparkles, WandSparkles } from "lucide-react";

type Options = { platform: string; tone: string; length: string; emojis: boolean; hashtags: boolean };
export default function CaptionGenerator({ signedIn, clips = [] }: { signedIn: boolean; clips?: { id: string; streamer: string | null; created_at: string }[] }) {
  const [topic, setTopic] = useState("");
  const [clipId, setClipId] = useState("");
  const [options, setOptions] = useState<Options>({ platform: "Instagram", tone: "Casual", length: "Medium", emojis: true, hashtags: true });
  const [result, setResult] = useState<{ captions: string[]; limit: number; platform: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState<number | null>(null);
  const inFlight = useRef(false);
  async function generate() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setCopied(null);
    try {
      const response = await fetch("/api/captions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, ...(clipId && { clipId }), ...options }), signal: AbortSignal.timeout(150_000) });
      const data = await response.json() as { captions: string[]; limit: number; error?: string };
      if (!response.ok) throw new Error(data.error || "Couldn't generate captions.");
      setResult({ ...data, platform: options.platform });
    } catch (e) { setError(e instanceof Error && e.name === "TimeoutError" ? "Generation timed out. Please try again." : e instanceof Error ? e.message : "Couldn't reach the caption service."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function copy(text: string, index: number) {
    try { await navigator.clipboard.writeText(text); setCopied(index); setError(""); }
    catch { setError("Clipboard access is unavailable. Select the caption text and copy it manually."); }
  }
  return <div className="caption-studio">
    <form className="panel caption-form" onSubmit={e => { e.preventDefault(); void generate(); }}>
      <div className="panel-heading"><div><h2><Sparkles size={18}/> Make every post count</h2><p>Built from your transcript or description. No API key needed.</p></div></div>
      <fieldset disabled={busy} className="caption-fields">
        <label>Caption source<select value={clipId} onChange={e => setClipId(e.target.value)}><option value="">Enter text</option>{clips.map(c => <option key={c.id} value={c.id}>{c.streamer || "Removed streamer"} / {new Date(c.created_at).toLocaleString()}</option>)}</select></label>
        {clipId ? <p className="caption-note">Uses the saved transcript and trim from this clip. Save transcript corrections in the clip editor before generating.</p> : <><label>Transcript or post description<textarea required minLength={10} maxLength={3000} rows={7} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Describe your photo, video, product, or moment. Include the details you want people to remember…"/><small>{topic.length.toLocaleString()} / 3,000 characters</small></label>
        <div className="caption-examples"><span>Try an idea</span>{["A behind-the-scenes look at how I edit my gaming clips", "Launching our new iced matcha at the café this Friday", "Three things I learned on my first solo hiking trip"].map((text, i) => <button type="button" key={text} onClick={() => setTopic(text)}>{["Behind the scenes", "Product launch", "Personal story"][i]}</button>)}</div></>}
        <div className="caption-selects"><label>Platform<select value={options.platform} onChange={e => setOptions({ ...options, platform: e.target.value })}>{["Instagram", "TikTok", "YouTube", "Facebook", "LinkedIn", "X"].map(x => <option key={x}>{x}</option>)}</select></label><label>Tone<select value={options.tone} onChange={e => setOptions({ ...options, tone: e.target.value })}>{["Casual", "Funny", "Professional", "Inspirational", "Bold"].map(x => <option key={x}>{x}</option>)}</select></label></div>
        <label>Caption length<select value={options.length} onChange={e => setOptions({ ...options, length: e.target.value })}>{["Short", "Medium", "Long"].map(x => <option key={x}>{x}</option>)}</select>{options.platform === "X" && <small>X captions use up to 240 characters for Short and 280 for Medium or Long.</small>}</label>
        <div className="caption-toggles"><label><input type="checkbox" checked={options.emojis} onChange={e => setOptions({ ...options, emojis: e.target.checked })}/> Include emoji</label><label><input type="checkbox" checked={options.hashtags} onChange={e => setOptions({ ...options, hashtags: e.target.checked })}/> Add hashtags</label></div>
      </fieldset>
      <div className="caption-submit"><button className="primary" disabled={busy || !signedIn || (!clipId && topic.trim().length < 10)} type="submit">{busy ? <Loader2 size={17} className="spin"/> : <WandSparkles size={17}/>} {busy ? "Writing your captions…" : "Generate captions"}</button><small>Three template variations. Edit before sharing.</small></div>
    </form>
    <section className="caption-results" aria-busy={busy} aria-label="Generated captions">
      <div className="caption-results-heading"><h2>Your captions</h2><span className="tag">{result ? result.platform : "3 variations"}</span></div>
      {error && <div className="error" role="alert">{error}</div>}
      <span className="caption-live" role="status">{busy ? "Generating three caption options." : copied !== null ? `Option ${copied + 1} copied.` : result ? "Three captions ready to edit and copy." : ""}</span>
      {result ? result.captions.map((text, i) => <article className="panel caption-result" key={i}><div className="caption-card-heading"><span>OPTION 0{i + 1}</span><button type="button" className="secondary" disabled={busy || !text.trim() || Array.from(text).length > result.limit} onClick={() => void copy(text, i)}>{copied === i ? <Check size={14}/> : <Copy size={14}/>} {copied === i ? "Copied" : "Copy"}</button></div><textarea aria-label={`Edit caption option ${i + 1}`} value={text} disabled={busy} onChange={e => { setCopied(null); setResult({ ...result, captions: result.captions.map((c, n) => n === i ? e.target.value : c) }); }}/><div className="caption-count"><span>{Array.from(text).length > result.limit ? "Shorten before copying" : "Click the text to make it yours"}</span><span className={Array.from(text).length > result.limit ? "engine-error" : ""}>{Array.from(text).length} / {result.limit}</span></div></article>) : <div className="panel caption-empty"><div className="caption-orbit"><Sparkles size={35}/></div><h3>A little inspiration goes a long way</h3><p>Choose a clip transcript or enter text to create three caption drafts. Edit your favourite, copy it, and share when you&apos;re ready.</p><div className="caption-skeleton"><span/><span/><span/></div><small>Captions appear here</small></div>}
      {result && <p className="caption-note">Review the details before sharing. Generating or copying a caption doesn&apos;t publish a post.</p>}
    </section>
  </div>;
}
