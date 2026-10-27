import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { finishPasskeySignIn } from "@/lib/auth/passkeys";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { sessionCookieHeader } from "@/lib/auth/sessions";

/**
 * POST `{ response }`: signs in with the passkey the browser used (#450). A
 * passkey sign-in counts as two-step, so this is a full sign-in. Recorded in
 * the sign-in monitor, and limited per address like other sign-ins.
 */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  await assertRemoteAllowed(request.headers);
  const body = await readJson(request, { maxBytes: 64 * 1024 });
  const signed = await finishPasskeySignIn(request, { response: body.response });
  return json({ user: signed.user, stage: "full" }, { headers: { "set-cookie": sessionCookieHeader(request, signed.token), "cache-control": "no-store" } });
});
