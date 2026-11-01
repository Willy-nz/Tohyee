import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { deleteEvent, getEvent } from "@/lib/security-cameras/events";
import { removeStored } from "@/lib/security-cameras/storage";

type Context = { params: Promise<{ eventId: string }> };

/** GET: one camera event. */
export const GET = route<Context>(async (request, context) => {
  const { eventId } = await context.params;
  const event = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getEvent(tx, eventId));
  return json({ event });
});

/**
 * DELETE: deletes the event and its photo or clip, for good (decision
 * 1222). Needs delete access; audited. The files go once the event's row
 * has gone.
 */
export const DELETE = route<Context>(async (request, context) => {
  const { eventId } = await context.params;
  const organisationId = searchParams(request).get("organisationId");
  let organisation = "";
  const deleted = await withFarmWork(request, organisationId, "read", async (tx) => {
    organisation = tx.organisationId;
    return deleteEvent(tx, eventId);
  });
  await removeStored(organisation, deleted.storagePath);
  return json({ deleted: true });
});
