import { json, readJson, route } from "@/lib/api/http";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertSameOrigin, authenticateAnyStage } from "@/lib/auth/guard";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";
import { loggedSignIn } from "@/lib/auth/sign-in-log";
import { verifySecondStep } from "@/lib/auth/two-step";

/** Finishes signing in with an authenticator `code` or a backup code. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  assertSignInRate(request);
  const state = await authenticateAnyStage(request);
  const body = await readJson(request);
  const result = await loggedSignIn(
    request,
    { email: state.user.email, userId: state.user.id },
    "code",
    () => verifySecondStep(state, { code: body.code }, sessionMetaFrom(request)),
    (signed) => ({ outcome: "signed_in", step: signed.usedBackupCode ? "backup_code" : "code" }),
  );
  return json(
    { user: result.user, usedBackupCode: result.usedBackupCode, backupCodesLeft: result.backupCodesLeft },
    { headers: { "set-cookie": sessionCookieHeader(request, result.token) } },
  );
});
