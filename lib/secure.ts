// Token encryption and signed media links. Self-contained (Web Crypto only) so it can be unit tested.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function keyBytes(secret: string) {
  const bytes = unb64(secret);
  if (bytes.length !== 32) throw new Error("Key must be 32 bytes, base64-encoded");
  return bytes;
}

// AES-256-GCM; output is "v1.<iv>.<ciphertext+tag>" so the format can change later without ambiguity.
export async function encrypt(plain: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return "v1." + b64(iv) + "." + b64(sealed);
}

export async function decrypt(box: string, secret: string) {
  const [version, iv, sealed] = box.split(".");
  if (version !== "v1" || !iv || !sealed) throw new Error("Unrecognised encrypted value");
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(sealed)));
}

async function hmac(message: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

// A link to one clip file that works without sign-in until `expiresAt` (epoch ms), for platforms that fetch the video themselves.
export async function signedMediaPath(clipId: string, expiresAt: number, secret: string) {
  const e = Math.floor(expiresAt / 1000);
  return "/media/" + clipId + ".mp4?e=" + e + "&s=" + await hmac(clipId + ":" + e, secret);
}

export async function verifyMediaSignature(clipId: string, e: string | null, s: string | null, secret: string, now = Date.now()) {
  if (!e || !s || !/^\d{1,12}$/.test(e) || Number(e) * 1000 < now) return false;
  const expected = await hmac(clipId + ":" + e, secret);
  // Constant-time comparison so the signature can't be guessed byte by byte from response timing.
  if (expected.length !== s.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0;
}

export const newKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
