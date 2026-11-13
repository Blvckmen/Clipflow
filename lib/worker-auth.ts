export async function hashToken(token:string){
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
export function newToken(){
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 return "cfw_"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
}
// Resolves the owner for a worker's bearer token, or null. Never trusts an owner supplied by the caller.
export async function workerOwner(request:Request,db:D1Database){
 const match=/^Bearer (cfw_[0-9a-f]{64})$/.exec(request.headers.get("authorization")||"");
 if(!match)return null;
 const row=await db.prepare("SELECT owner FROM worker_tokens WHERE token_hash=?").bind(await hashToken(match[1])).first<{owner:string}>();
 return row?.owner??null;
}
