import { env } from "cloudflare:workers";
export function database(){if(!env.DB)throw new Error("Database unavailable");return env.DB;}
// Clip file storage is optional; callers degrade to metadata-only when it is absent.
export function bucket(){return env.BUCKET??null;}
export const clipKey=(id:string)=>"clips/"+id+".mp4";
// A clip's unframed source, kept so the clip can be re-edited.
export const sourceKey=(id:string)=>"sources/"+id+".mp4";
