import { env } from "cloudflare:workers";
export function database(){if(!env.DB)throw new Error("Database unavailable");return env.DB;}
// Clip file storage is optional; callers degrade to metadata-only when it is absent.
export function bucket(){return env.BUCKET??null;}
export const clipKey=(id:string)=>"clips/"+id+".mp4";
// A clip's unframed source, kept so the clip can be re-edited.
export const sourceKey=(id:string)=>"sources/"+id+".mp4";
// A whole-stream recording's small scrubbing copy (the full-quality file stays on the worker PC).
export const previewKey=(id:string)=>"previews/"+id+".mp4";
// A whole recording's transcript, {lines: [[start, end, text], ...]} in seconds, for searching what was said.
export const transcriptKey=(id:string)=>"transcripts/"+id+".json";
// A clip's version in another language (clip_translations), one key per edit revision.
export const translationKey=(id:string,lang:string,rev:number)=>"clips/"+id+"-"+lang+"-r"+rev+".mp4";
