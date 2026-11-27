// Pairing codes: Connect worker shows one (e.g. "4F7K-9Q2M"), and the PC trades it once for a worker token through
// POST /api/worker/pair (worker/pair.mjs), so nobody copies the site address and a 68-character token by hand.
// 8 characters from 29 that can't be mistaken for each other (no 0/O, 1/I/L, U/V): about 5 × 10^11 codes, each
// valid for 10 minutes and once, so guessing one isn't practical.

export const PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
export const PAIR_LENGTH = 8;
export const PAIR_TTL_MS = 10 * 60_000;

/** A new code, shown as "XXXX-XXXX". */
export function newPairCode() {
  // Rejection sampling keeps every character equally likely (256 isn't a multiple of the alphabet's length).
  const limit = 256 - (256 % PAIR_ALPHABET.length);
  let code = "";
  while (code.length < PAIR_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(PAIR_LENGTH * 2))) {
      if (b < limit && code.length < PAIR_LENGTH) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
    }
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

/** The code as typed (any case, spaces or dashes) in its stored form, or null if it can't be one. */
export function normalizePairCode(input) {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIR_LENGTH || [...code].some(c => !PAIR_ALPHABET.includes(c))) return null;
  return code;
}

/** SHA-256 of the normalized code, as stored in pairing_codes.code_hash. */
export async function hashPairCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pair:" + code));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
