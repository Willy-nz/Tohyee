import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { disconnectFarmMailbox, setMailboxFarm } from "@/lib/farming/calendar";

type Context = { params: Promise<{ mailboxId: string }> };

/** PATCH: the farm for items that name none (FC11). Body: { organisationId, defaultFarmId }. The member's own mailbox only. */
export const PATCH = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const mailboxes = await withOrganisation(request, body.organisationId, "viewer", (tx) => setMailboxFarm(tx, mailboxId, body.defaultFarmId));
  return json({ mailboxes });
});

/** DELETE ?organisationId=: disconnects it and deletes everything read from it (FC15). */
export const DELETE = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const mailboxes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => disconnectFarmMailbox(tx, mailboxId));
  return json({ mailboxes });
});
