import { returnOrigin } from "@/lib/auth/origin";

/**
 * The address this request came in on, which is where the browser returns
 * after signing in to Google or Microsoft (so the session cookie is there).
 * Google and Microsoft only return to addresses registered in the
 * organisation's app. Through remote access it's the configured public
 * address, and never a forwarded host a visitor typed (decision 534).
 */
export function requestOrigin(request: Request): Promise<string> {
  return returnOrigin(request);
}
