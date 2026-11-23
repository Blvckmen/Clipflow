import { currentUser } from "../../auth";
import { database } from "../../../db/raw";
import { readOptions } from "../../../lib/account-options";
import { postingHours } from "../../../lib/publisher";
import { forecast, hoursLabel, spreadGap } from "../../../lib/posting-plan.mjs";
export const dynamic="force-dynamic";

// The Publishing calendar: what each account posted in a week, and when everything still queued should go out.
// GET /api/calendar?from=<ISO>&to=<ISO> (at most 8 days apart; the client sends its own week, Monday to Monday).
// Upcoming posts are forecast with the publisher's own rules (lib/posting-plan.mjs forecast), so the calendar shows
// what will happen rather than a separate plan. Kept out of the dashboard load: it reads each account's best hours.
const ISO=/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, DAY=86_400_000;
type AccountRow={id:string;platform:string;username:string;options:string|null;daily_limit:number|null;control:string|null};
type Upcoming={id:string;clip_id:string;account_id:string;state:string;created_at:string;next_attempt_at:string;queued_by_hand:number;scheduled_for:string|null;draft:number;error:string|null;streamer:string|null;score:number|null;duration:number|null};

export async function GET(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see the calendar."},{status:401});
 const q=new URL(request.url).searchParams, from=q.get("from")??"", to=q.get("to")??"";
 if(!ISO.test(from)||!ISO.test(to)||Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>8*DAY)return Response.json({error:"Pick a week to show."},{status:400});
 try{
  const db=database(), owner=user.userId, now=Date.now(), since=new Date(now-DAY).toISOString();
  const {results:accounts}=await db.prepare("SELECT a.id,a.platform,a.username,a.options,p.daily_limit,p.control FROM accounts a LEFT JOIN preferences p ON p.owner=a.owner WHERE a.owner=? AND a.status='connected'").bind(owner).all<AccountRow>();
  const ids=JSON.stringify(accounts.map(a=>a.id));
  const [posted,upcoming,recent]=await db.batch([
   // Posted this week, by when they went out (posts_account_published).
   db.prepare("SELECT p.id,p.clip_id,p.account_id,p.published_at AS at,p.permalink,p.views,p.draft,s.name AS streamer,json_extract(c.signals,'$.score') AS score,c.duration FROM posts p INDEXED BY posts_account_published LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE p.account_id IN (SELECT value FROM json_each(?)) AND p.state='published' AND p.published_at>=? AND p.published_at<? AND p.owner=? ORDER BY p.published_at LIMIT 500").bind(ids,from,to,owner),
   // Everything not posted yet (posts_owner_state).
   db.prepare("SELECT p.id,p.clip_id,p.account_id,p.state,p.created_at,p.next_attempt_at,p.queued_by_hand,p.scheduled_for,p.draft,p.error,s.name AS streamer,json_extract(c.signals,'$.score') AS score,c.duration FROM posts p INDEXED BY posts_owner_state LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE p.owner=? AND p.state IN ('queued','processing','review') ORDER BY p.created_at LIMIT 300").bind(owner),
   // What each account sent in the last day, for its daily limit and gap (as the publisher counts it).
   db.prepare("SELECT account_id,published_at AS at FROM posts WHERE account_id IN (SELECT value FROM json_each(?)) AND state='published' AND published_at>=? UNION ALL SELECT account_id,updated_at AS at FROM posts WHERE account_id IN (SELECT value FROM json_each(?)) AND state='processing' AND updated_at>=?").bind(ids,since,ids,since),
  ]);
  const up=upcoming.results as Upcoming[], sent=recent.results as {account_id:string;at:string}[];
  const planned:Record<string,{at?:number;held?:boolean;later?:boolean}>={};
  const summary=[];
  for(const a of accounts){
   const options=readOptions(a.options), limit=options.dailyLimit??a.daily_limit??5;
   const hours=await postingHours(db,a.id,options,now), autoGap=spreadGap(hours,limit,options.gapMinutes,options.spread);
   const queue=up.filter(p=>p.account_id===a.id&&p.state==="queued").map(p=>({id:p.id,createdAt:Date.parse(p.created_at),due:Date.parse(p.next_attempt_at),byHand:!!p.queued_by_hand}));
   // One in flight: it counts as sent now, and the rest wait behind it.
   const busy=up.some(p=>p.account_id===a.id&&p.state==="processing");
   Object.assign(planned,forecast({platform:a.platform,limit,gapMinutes:options.gapMinutes,autoGapMinutes:autoGap,hours,timeZone:options.timeZone,holdWhenFull:options.whenFull==="review",sent:[...sent.filter(s=>s.account_id===a.id).map(s=>Date.parse(s.at)),...(busy?[now]:[])],queue,now}));
   summary.push({id:a.id,platform:a.platform,username:a.username,limit,gapMinutes:autoGap,spread:options.spread,hours:options.hours,hoursLabel:hours?hoursLabel(hours):"any time",timeZone:options.timeZone,paused:(a.control??"running")!=="running"});
  }
  const iso=(ms:number|undefined)=>ms===undefined?null:new Date(ms).toISOString();
  const items=[
   ...posted.results.map(p=>({...(p as object),kind:"posted"})),
   ...up.map(p=>{
    const f=planned[p.id];
    const kind=p.state==="processing"?"posting":p.state==="review"||f?.held?"held":f?.later||!f?"later":p.scheduled_for?"scheduled":"planned";
    return {id:p.id,clip_id:p.clip_id,account_id:p.account_id,streamer:p.streamer,score:p.score,duration:p.duration,draft:p.draft,kind,at:p.state==="processing"?new Date(now).toISOString():iso(f?.at),scheduled_for:p.scheduled_for,note:p.error};
   }),
  ];
  return Response.json({now:new Date(now).toISOString(),accounts:summary,items},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Calendar load failed",error);return Response.json({error:"The calendar is unavailable right now."},{status:503});}
}
