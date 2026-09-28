import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { completeSetup, needsSetup } from "@/lib/auth/service";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";

/** Whether first-time setup is still needed (no users yet). Public. */
export const GET = route(async () => {
  return json({ needsSetup: await needsSetup() });
});

/** Creates the first server admin. Needs the SETUP_TOKEN from the server's environment. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await completeSetup(
    {
      setupToken: body.setupToken,
      email: body.email,
      displayName: body.displayName,
      password: body.password,
    },
    sessionMetaFrom(request),
  );
  return json(
    { user: result.user, stage: result.stage },
    { status: 201, headers: { "set-cookie": sessionCookieHeader(request, result.token) } },
  );
});
