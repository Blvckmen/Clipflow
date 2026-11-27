"use client";
// Saved looks: the workspace's saved text styles (worker/text-style.mjs: the subtitle and title look, without the
// clip's own text and switches). Apply one to this clip, save this clip's look under a name, delete one, or move a
// look between workspaces as a .json file.
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Save, Trash2, Upload } from "lucide-react";
import { applyTextStyle, readTemplateFile, textStyleOf, toTemplateFile } from "../../../worker/text-style.mjs";
import { readJson } from "../../../lib/read-json.mjs";
import type { Change, Edit } from "../types";

type Saved = { id: string; name: string; style: unknown };

export function SavedLooks({ edit, change }: { edit: Edit; change: Change }) {
  const [styles, setStyles] = useState<Saved[] | null>(null), [chosen, setChosen] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(""), [note, setNote] = useState(""), file = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { const b = await readJson<{ styles?: Saved[] }>(await fetch("/api/text-styles")); setStyles(b.styles ?? []); } catch { setStyles([]); }
  }, []);
  useEffect(() => { let live = true; fetch("/api/text-styles").then(r => readJson<{ styles?: Saved[] }>(r)).then(b => { if (live) setStyles(b.styles ?? []); }).catch(() => { if (live) setStyles([]); }); return () => { live = false; }; }, []);
  const apply = (style: unknown, label: string) => {
    try { change("text-style", e => applyTextStyle(e, style) as Edit); setNote("Applied “" + label + "”. Undo takes it back."); }
    catch (e) { setNote((e as Error).message + "."); }
  };
  const post = async (body: object, what: string) => {
    setBusy(what); setNote("");
    try {
      const response = await fetch("/api/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await readJson<{ error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(result.error || "Please retry.");
      setNote(result.message ?? ""); await load(); return true;
    } catch (e) { setNote((e as Error).message); return false; } finally { setBusy(""); }
  };
  const save = async () => { if (await post({ action: "saveTextStyle", name, style: textStyleOf(edit) }, "save")) setName(""); };
  const remove = async () => { const s = styles?.find(x => x.id === chosen); if (s && window.confirm("Delete the saved look “" + s.name + "”?")) { if (await post({ action: "deleteTextStyle", id: s.id }, "delete")) setChosen(""); } };
  const exportLook = () => {
    try {
      const label = name.trim() || styles?.find(x => x.id === chosen)?.name || "My look";
      const a = document.createElement("a"), url = URL.createObjectURL(new Blob([toTemplateFile(textStyleOf(edit), label)], { type: "application/json" }));
      a.href = url; a.download = label.replace(/[^\w-]+/g, "_") + ".clipflow-style.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setNote((e as Error).message + "."); }
  };
  const importLook = async (f: File | undefined) => {
    if (!f) return;
    try { const { name: n, style } = readTemplateFile(await f.text()); apply(style, n); setName(n); setNote("Applied “" + n + "”. Save it to keep it in this workspace."); }
    catch (e) { setNote((e as Error).message + "."); }
    finally { if (file.current) file.current.value = ""; }
  };
  const picked = styles?.find(x => x.id === chosen);

  return <div className="saved-looks">
    <h3>Saved looks</h3>
    <div className="find-row">
      <select aria-label="Saved look" value={chosen} onChange={e => setChosen(e.target.value)} disabled={!styles?.length}>
        <option value="">{styles === null ? "Loading…" : styles.length ? "Pick a saved look" : "No saved looks yet"}</option>
        {styles?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button type="button" className="secondary" disabled={!picked} onClick={() => picked && apply(picked.style, picked.name)}>Apply</button>
      <button type="button" className="icon-button" aria-label="Delete saved look" title="Delete this saved look" disabled={!picked || !!busy} onClick={() => void remove()}>{busy === "delete" ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}</button>
    </div>
    <div className="find-row">
      <input aria-label="Name for this look" placeholder="Name this look" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
      <button type="button" className="secondary" disabled={!name.trim() || !!busy} onClick={() => void save()}>{busy === "save" ? <Loader2 className="spin" size={15} /> : <Save size={15} />}Save</button>
    </div>
    <div className="find-row">
      <button type="button" className="secondary" onClick={exportLook}><Download size={15} />Export</button>
      <button type="button" className="secondary" onClick={() => file.current?.click()}><Upload size={15} />Import</button>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => void importLook(e.target.files?.[0])} />
    </div>
    {note && <p className="hint" role="status">{note}</p>}
  </div>;
}
