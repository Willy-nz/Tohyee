import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";
import { loggedSignIn } from "@/lib/auth/sign-in-log";
import { completeTwoStepReset } from "@/lib/auth/two-step";

/** Uses an emailed reset link (`token`) with the `password`: two-step is reset and setting it up again starts. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  const body = await readJson(request);
  const result = await loggedSignIn(
    request,
    { email: null },
    "reset_link",
    async () => {
      assertRemoteAllowed(request.headers);
      return completeTwoStepReset({ token: body.token, password: body.password }, sessionMetaFrom(request));
    },
    (signed) => ({ outcome: "password_ok", userId: signed.user.id }),
  );
  return json({ user: result.user }, { headers: { "set-cookie": sessionCookieHeader(request, result.token) } });
});
