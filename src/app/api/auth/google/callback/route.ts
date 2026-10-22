import { finishGoogleSignIn } from "@/lib/auth/google-sign-in";

/**
 * Where Google sends the browser back (#424). It's a plain GET from Google's
 * page, so it can't be checked for same-origin: the one-time state, the
 * browser's own cookie and the PKCE verifier do that job instead.
 */
export async function GET(request: Request): Promise<Response> {
  const result = await finishGoogleSignIn(request);
  const headers = new Headers({ Location: result.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
