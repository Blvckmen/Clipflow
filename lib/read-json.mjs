// Reading the dashboard API's answers in the browser. Every API route answers JSON, even on error, so an answer that
// isn't JSON came from something in front of the app: the Cloudflare Access sign-in page once the session has
// expired (after hours with the tab open), or a Cloudflare or framework error page. Parsing that as JSON shows
// "Unexpected token '<', "<!DOCTYPE "... is not valid JSON"; these say what happened and what to do instead.

export const SIGNED_OUT = "Your sign-in has expired. Reload the page to sign in again.";
export const OFFLINE = "Couldn't reach Clipflow. Check your connection, then reload the page.";
export const errorPage = status => "Clipflow answered with an error page" + (status ? " (HTTP " + status + ")" : "") + ". Reload the page and try again.";

// An answer that went to the sign-in page: Access redirects there, or answers 401/403 itself.
const signedOut = response => response.status === 401 || response.status === 403 || /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(response.url ?? "");

/**
 * The answer's JSON, or an Error with a message a person can act on when it's a web page instead.
 * @template T
 * @param {Response} response
 * @returns {Promise<T>}
 */
export async function readJson(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    if (signedOut(response) || response.redirected) throw new Error(SIGNED_OUT);
    throw new Error(errorPage(response.status));
  }
  try { return await response.json(); }
  catch { throw new Error(errorPage(response.status)); }
}

/**
 * fetch(), with the browser's "Failed to fetch" (offline, or a sign-in redirect it may not follow) said plainly.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export async function apiFetch(input, init) {
  try { return await fetch(input, init); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(OFFLINE);
  }
}
