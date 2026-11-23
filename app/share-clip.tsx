"use client";
// "Post it yourself in the TikTok app": past TikTok's 15 videos a day from apps, a clip can still go out by hand.
// On a phone the video goes to the share sheet (pick TikTok) with the caption on the clipboard; on a computer it is
// downloaded and TikTok's upload page opens. Then "Mark as posted" tells Clipflow, so it isn't sent there again.
import { useState } from "react";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";

type Account = { id: string; username: string };

export function ShareClip({ clipId, caption, tiktokAccounts, busy, onMarked }: {
  clipId: string; caption: string; tiktokAccounts: Account[]; busy: boolean; onMarked: (accountId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null), [state, setState] = useState<"" | "loading" | "ready" | "shared" | "downloaded">(""), [note, setNote] = useState("");
  const [account, setAccount] = useState(tiktokAccounts[0]?.id ?? "");
  const copy = async () => { if (!caption) return false; try { await navigator.clipboard.writeText(caption); return true; } catch { return false; } };
  const canShareFiles = (f: File) => typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [f] });

  // Step 1 fetches the video. Phones only open the share sheet straight after a tap, so sharing is a second tap.
  const prepare = async () => {
    setState("loading"); setNote("");
    try {
      const response = await fetch("/api/clips/" + clipId + "/file");
      if (!response.ok) throw new Error("Couldn't load the video (HTTP " + response.status + ").");
      const f = new File([await response.blob()], "clip-" + clipId.slice(0, 8) + ".mp4", { type: "video/mp4" });
      if (canShareFiles(f)) { setFile(f); setState("ready"); return; }
      // A computer: download it, copy the caption and open TikTok's upload page.
      const url = URL.createObjectURL(f), a = document.createElement("a");
      a.href = url; a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const copied = await copy();
      window.open("https://www.tiktok.com/tiktokstudio/upload", "_blank", "noopener");
      setState("downloaded"); setNote("Video downloaded" + (copied ? " and post text copied" : "") + ". Upload it on the TikTok page that just opened" + (copied ? " and paste the post text." : "."));
    } catch (e) { setState(""); setNote(e instanceof Error ? e.message : "Couldn't prepare the video."); }
  };
  const share = async () => {
    if (!file) return;
    const copied = await copy();
    try {
      await navigator.share({ files: [file] });
      setState("shared"); setNote("Pick TikTok, then " + (copied ? "paste the post text (it's copied) and " : "") + "post. Mark it below once it's up.");
    } catch (e) { if ((e as Error).name !== "AbortError") setNote("Couldn't open the share sheet: " + (e as Error).message); }
  };

  return <div className="share-clip">
    <div className="share-head"><Smartphone size={16} /><div><strong>Post it yourself in the TikTok app</strong><small>Doesn&apos;t count towards TikTok&apos;s 15 videos a day from apps. Best from your phone.</small></div></div>
    <div className="share-actions">
      {state === "ready"
        ? <button className="primary" type="button" onClick={() => void share()}><Smartphone size={15} />Open in TikTok</button>
        : <button className="secondary" type="button" disabled={state === "loading"} onClick={() => void prepare()}>{state === "loading" ? <Loader2 size={15} className="spin" /> : <Smartphone size={15} />}{state === "loading" ? "Preparing video…" : state ? "Again" : "Post in the TikTok app"}</button>}
      {caption && <button className="text-button" type="button" onClick={() => void copy().then(ok => setNote(ok ? "Post text copied." : "Couldn't copy; select it in the editor's Post text tab."))}><Copy size={13} />Copy post text</button>}
    </div>
    {note && <p className="hint" role="status">{note}</p>}
    {(state === "shared" || state === "downloaded") && tiktokAccounts.length > 0 && <div className="share-mark">
      <span>Posted it? Tell Clipflow which page, so it isn&apos;t sent there automatically too:</span>
      <select value={account} onChange={e => setAccount(e.target.value)}>{tiktokAccounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}</select>
      <button className="secondary" type="button" disabled={busy || !account} onClick={() => onMarked(account)}><Check size={14} />Mark as posted</button>
    </div>}
  </div>;
}
