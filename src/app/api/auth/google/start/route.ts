import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { startGoogleSignIn } from "@/lib/auth/google-sign-in";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";

/**
 * POST `{ purpose: "sign_in", next? }`, `{ purpose: "setup", token }` or
 * `{ purpose: "link", password }`: Google's sign-in address (#424), and a
 * cookie that ties the trip to this browser.
 */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  await assertRemoteAllowed(request.headers);
  const body = await readJson(request);
  const started = await startGoogleSignIn(request, { purpose: body.purpose, next: body.next, token: body.token, password: body.password });
  return json({ url: started.url }, { headers: { "set-cookie": started.cookie, "cache-control": "no-store" } });
});
