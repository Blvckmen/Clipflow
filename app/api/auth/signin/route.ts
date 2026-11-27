import { googleSignIn, twitchSignIn } from "../../../auth";
import { PROVIDERS, safeReturn } from "../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
// The sign-in page when the site offers more than one way in (app/auth.ts signInPath): a button for each, carrying
// where to go afterwards. A plain page, so it works before anyone is signed in and needs no app code.
export async function GET(request:Request){
 const url=new URL(request.url),back=safeReturn(url.searchParams.get("return_to"));
 const ways=([["twitch",twitchSignIn()],["google",googleSignIn()]] as const).filter(([,on])=>on).map(([id])=>PROVIDERS[id]);
 if(ways.length===1)return Response.redirect(url.origin+ways[0].start+"?return_to="+encodeURIComponent(back),302);
 const problem=(url.searchParams.get("signin_error")??"").slice(0,300);
 const buttons=ways.map(w=>`<a class="way ${esc(w.label.toLowerCase())}" href="${esc(w.start)}?return_to=${encodeURIComponent(back)}">Continue with ${esc(w.label)}</a>`).join("");
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to ClipFlow</title>
<style>
:root{--bg:#0c0f14;--panel:#151a22;--text:#eef2f7;--muted:#9aa6b2;--line:#263040;--accent:#bcfa76}
@media (prefers-color-scheme: light){:root{--bg:#f4f6f9;--panel:#fff;--text:#111827;--muted:#5b6675;--line:#dde3ea;--accent:#3f7d12}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 20px;color:var(--muted);font-size:14px}
.way{display:block;text-align:center;text-decoration:none;font-weight:600;padding:12px 14px;border-radius:10px;border:1px solid var(--line);color:var(--text);margin-top:10px}
.way:hover,.way:focus-visible{border-color:var(--accent);outline:none}.twitch{background:#9146ff;border-color:#9146ff;color:#fff}
.problem{color:#ff8a80;margin-bottom:12px}small{display:block;margin-top:18px;color:var(--muted);font-size:12px}
</style></head><body><main><h1>Sign in to ClipFlow</h1><p>Use the account you signed up with. You can link the other one later in Settings → Account &amp; data.</p>
${problem?`<p class="problem" role="alert">${esc(problem)}</p>`:""}${buttons}<small>ClipFlow only reads your name and email.</small></main></body></html>`;
 return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
}
