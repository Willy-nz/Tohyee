import { decideConsent } from "@/lib/ai/oauth/authorize";
import { json, readJson, requireAuth, route } from "@/lib/api/http";

type Context = { params: Promise<{ handle: string }> };

/**
 * POST { decision: "allow" | "deny", organisationId, accessLevel, confirmFullAccess? }:
 * the consent screen's answer (#427, decision 819). Signed in, same origin,
 * and from the browser that started the request (its cookie). Answers
 * { redirectTo }: back to the app with a code, or with access_denied.
 */
export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const { handle } = await context.params;
  const body = await readJson(request);
  return json(await decideConsent(auth, request, handle, body));
});
