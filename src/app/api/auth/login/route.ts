import { json, readJson, route } from "@/lib/api/http";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { assertSameOrigin } from "@/lib/auth/guard";
import { signIn } from "@/lib/auth/service";
import { loggedSignIn } from "@/lib/auth/sign-in-log";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";

export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  const body = await readJson(request);
  // Recorded for the sign-in monitor (#208), refusals and failures too.
  const result = await loggedSignIn(
    request,
    { email: typeof body.email === "string" ? body.email : null },
    "password",
    async () => {
      assertRemoteAllowed(request.headers);
      return signIn({ email: body.email, password: body.password }, sessionMetaFrom(request));
    },
    (signed) => ({ outcome: signed.stage === "full" ? "signed_in" : "password_ok", userId: signed.user.id }),
  );
  return json(
    { user: result.user, stage: result.stage },
    { headers: { "set-cookie": sessionCookieHeader(request, result.token) } },
  );
});
