import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";
import { completeTwoStepReset } from "@/lib/auth/two-step";

/** Uses an emailed reset link (`token`) with the `password`: two-step is reset and setting it up again starts. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await completeTwoStepReset({ token: body.token, password: body.password }, sessionMetaFrom(request));
  return json({ user: result.user }, { headers: { "set-cookie": sessionCookieHeader(request, result.token) } });
});
