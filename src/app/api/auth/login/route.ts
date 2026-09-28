import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { signIn } from "@/lib/auth/service";
import { sessionCookieHeader, sessionMetaFrom } from "@/lib/auth/sessions";

export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await signIn({ email: body.email, password: body.password }, sessionMetaFrom(request));
  return json(
    { user: result.user, stage: result.stage },
    { headers: { "set-cookie": sessionCookieHeader(request, result.token) } },
  );
});
