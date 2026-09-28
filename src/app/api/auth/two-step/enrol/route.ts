import { json, readJson, route, searchParams } from "@/lib/api/http";
import { assertSameOrigin, authenticateAnyStage } from "@/lib/auth/guard";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";
import { completeEnrolment, startEnrolment } from "@/lib/auth/two-step";

/** GET: the key to add to an authenticator app (QR code and text). `fresh=true` makes a new one. */
export const GET = route(async (request) => {
  const state = await authenticateAnyStage(request);
  return json(await startEnrolment(state, { fresh: searchParams(request).get("fresh") === "true" }));
});

/** Confirms the app with its first `code`, turns two-step sign-in on and returns the backup codes (shown once). */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const state = await authenticateAnyStage(request);
  const body = await readJson(request);
  const result = await completeEnrolment(state, { code: body.code }, sessionMetaFrom(request));
  return json(
    { user: result.user, backupCodes: result.backupCodes },
    { headers: { "set-cookie": sessionCookieHeader(request, result.token) } },
  );
});
