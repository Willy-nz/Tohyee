import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withCrm } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { startConnect } from "@/lib/crm/mail/service";

/**
 * The Google or Microsoft sign-in address for connecting the signed-in
 * user's mailbox (example MAIL2); `send: true` also asks to send sales
 * emails from it (decision 496).
 */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx) => startConnect(tx, body.provider, requestOrigin(request), { send: body.send }));
  return json(result);
});
