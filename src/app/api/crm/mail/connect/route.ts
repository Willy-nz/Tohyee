import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { startConnect } from "@/lib/crm/mail/service";

/** The Google or Microsoft sign-in address for connecting the signed-in user's mailbox (example MAIL2). */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => startConnect(tx, body.provider, requestOrigin(request)));
  return json(result);
});
