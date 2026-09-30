import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { startMicrosoftSending } from "@/lib/email/microsoft";

/** The Microsoft sign-in address for connecting the mailbox documents are sent from (admins). */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => startMicrosoftSending(tx, requestOrigin(request)));
  return json(result);
});
