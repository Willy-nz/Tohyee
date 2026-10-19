import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { listFarmMailboxes, startFarmMailConnect } from "@/lib/farming/calendar";

/** GET: the signed-in member's own farm mailboxes (FC1). Nobody else's, admins included. */
export const GET = route(async (request) => {
  const mailboxes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listFarmMailboxes(tx));
  return json({ mailboxes });
});

/** POST: starts connecting a mailbox. Body: { organisationId, provider, historyDays?, defaultFarmId? }. Returns the sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    startFarmMailConnect(tx, { provider: body.provider, historyDays: body.historyDays, defaultFarmId: body.defaultFarmId }, origin),
  );
  return json(result);
});
