/**
 * The address this request came in on, which is where the browser returns
 * after signing in to Google or Microsoft (so the session cookie is there).
 * Google and Microsoft only return to addresses registered in the
 * organisation's app, so a forged Host header can't send a code elsewhere.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}
