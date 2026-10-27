import { json, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { startPasskeySignIn } from "@/lib/auth/passkeys";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";

/** POST: the options for "Sign in with a passkey" (#450): a challenge for this browser, and no email or passkey list. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  await assertRemoteAllowed(request.headers);
  const started = await startPasskeySignIn(request);
  return json({ options: started.options }, { headers: { "set-cookie": started.cookie, "cache-control": "no-store" } });
});
