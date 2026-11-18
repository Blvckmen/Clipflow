import { z } from "zod";
export const destinations=["TikTok","Instagram","YouTube","Facebook","X"] as const;
export const framings={blur:"Blurred background",crop:"Centre crop",fit:"Fit with black bars",split:"Split screen (background video below)",cam:"Facecam on top, gameplay below",pip:"Gameplay with the facecam in a corner"} as const;
export const settingsSchema=z.object({mode:z.enum(["automatic","review"]),duration:z.number().int().min(15).max(90),dailyLimit:z.number().int().min(1).max(50),captions:z.boolean(),framing:z.enum(["blur","crop","fit","split","cam","pip"]),destinations:z.array(z.enum(destinations)).max(5).transform(x=>[...new Set(x)]),captionTemplate:z.string().trim().min(1).max(500).optional(),
 // Omitted by older clients: the saved values are kept.
 aiCaptions:z.boolean().optional(),captionNotes:z.string().trim().max(1000).optional(),
 // Whether the worker transcribes clips (Whisper). Off saves time and CPU; captions then need it back on.
 transcribe:z.boolean().optional(),
 // Days whole-stream recordings are kept.
 recordingDays:z.number().int().min(1).max(30).optional()});
// A streamer's own publishing mode; "workspace" follows Settings → Publishing mode.
export const publishModes={workspace:"Use the workspace setting",review:"Review clips first",automatic:"Post to social media directly"} as const;
export const defaultCaption="{streamer} on {platform} #clips #{platform}";
export const defaults={mode:"automatic",duration:45,dailyLimit:5,captions:true,framing:"blur",destinations:[] as string[],control:"paused",captionTemplate:defaultCaption,aiCaptions:true,captionNotes:"",transcribe:true,recordingDays:7};
export const captureModes={clip:"Clip live",record:"Record the whole stream, clip it afterwards",both:"Clip live and record the whole stream"} as const;
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
 }else if(host==="tiktok.com"||host==="m.tiktok.com"){
  // TikTok LIVE is recorded from the profile's /live page; usernames are 2-24 letters, digits, "_" or ".".
  platform="TikTok";if(parts.at(-1)==="live")parts.pop();
  if(parts.length!==1||!/^@[a-zA-Z0-9_.]{2,24}$/.test(parts[0]))throw new Error("Use a TikTok profile URL like https://www.tiktok.com/@name, not a video link.");
  parts[0]=parts[0].toLowerCase();
  return {platform,url:"https://www.tiktok.com/"+parts[0],name:parts[0].slice(1)};
 }else throw new Error("Supported channel hosts: twitch.tv, youtube.com, kick.com, and tiktok.com.");
 return {platform,url:"https://"+host+"/"+parts.join("/"),name:decodeURIComponent(parts.at(-1)!).replace(/^@/,"")};
}
