import { z } from "zod";
export const destinations=["TikTok","Instagram","YouTube","Facebook","X"] as const;
export const framings={blur:"Blurred background",crop:"Centre crop",fit:"Fit with black bars"} as const;
export const settingsSchema=z.object({mode:z.enum(["automatic","review"]),duration:z.number().int().min(15).max(90),dailyLimit:z.number().int().min(1).max(50),captions:z.boolean(),framing:z.enum(["blur","crop","fit"]),destinations:z.array(z.enum(destinations)).max(5).transform(x=>[...new Set(x)]),captionTemplate:z.string().trim().min(1).max(500).optional(),
 // Omitted by older clients: the saved values are kept.
 aiCaptions:z.boolean().optional(),captionNotes:z.string().trim().max(1000).optional()});
export const defaultCaption="{streamer} on {platform} #clips #{platform}";
export const defaults={mode:"automatic",duration:45,dailyLimit:5,captions:true,framing:"blur",destinations:[] as string[],control:"paused",captionTemplate:defaultCaption,aiCaptions:true,captionNotes:""};
// Platforms this build can actually publish to once an account is connected.
export const publishable=["Instagram"] as const;
export function parseStreamer(input:string){
 let url:URL; try{url=new URL(input.trim());}catch{throw new Error("Paste a complete channel URL, including https://.");}
 if(url.protocol!=="https:"||url.username||url.password||url.port)throw new Error("Use a secure channel URL without credentials or a port.");
 const host=url.hostname.toLowerCase().replace(/^www\./,""),parts=url.pathname.split("/").filter(Boolean);let platform:string;
 if(host==="twitch.tv"||host==="kick.com"){
  platform=host==="twitch.tv"?"Twitch":"Kick";
  if(parts.length!==1||!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{1,49}$/.test(parts[0])||["directory","videos","clips","search","settings","downloads","subscriptions","following","browse"].includes(parts[0].toLowerCase()))throw new Error("Use the streamer's channel URL, not a clip or directory page.");
  parts[0]=parts[0].toLowerCase();
 }else if(host==="youtube.com"){
  platform="YouTube";if(parts.at(-1)==="live")parts.pop();
  if(!((parts.length===1&&/^@[\p{L}\p{N}_.-]{3,40}$/u.test(decodeURIComponent(parts[0])))||(parts.length===2&&parts[0]==="channel"&&/^UC[a-zA-Z0-9_-]{22}$/.test(parts[1]))))throw new Error("Use a YouTube @handle or /channel/ URL, not a video link.");
 }else throw new Error("Supported channel hosts: twitch.tv, youtube.com, and kick.com.");
 return {platform,url:"https://"+host+"/"+parts.join("/"),name:decodeURIComponent(parts.at(-1)!).replace(/^@/,"")};
}
