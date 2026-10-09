import { json, readJson, route, searchParams } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { completeAccountSetup, readSetupLink } from "@/lib/auth/setup-links";
import { loggedSignIn } from "@/lib/auth/sign-in-log";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";

/** GET `?token=`: whether a setup link still works, and whose login it's for (#208). */
export const GET = route(async (request) => {
  assertSignInRate(request);
  return json(await readSetupLink(searchParams(request).get("token")));
});

/** POST `{ token, password }`: uses the link; then two-step sign-in is set up straight away. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  const body = await readJson(request);
  const result = await loggedSignIn(
    request,
    { email: null },
    "setup_link",
    async () => {
      assertRemoteAllowed(request.headers);
      return completeAccountSetup({ token: body.token, password: body.password }, sessionMetaFrom(request));
    },
    (signed) => ({ outcome: "password_ok", userId: signed.user.id }),
  );
  return json({ user: result.user }, { headers: { "set-cookie": sessionCookieHeader(request, result.token) } });
});
