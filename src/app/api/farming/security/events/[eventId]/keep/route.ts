import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { keepEvent, unkeepEvent } from "@/lib/security-cameras/events";

type Context = { params: Promise<{ eventId: string }> };

/** PUT `{ note }`: keeps the event out of the clean-up (an incident). Anyone who can see it. */
export const PUT = route<Context>(async (request, context) => {
  const { eventId } = await context.params;
  const body = await readJson(request);
  const event = await withFarmWork(request, body.organisationId, "read", (tx) => keepEvent(tx, eventId, body.note));
  return json({ event });
});

/** DELETE: stops keeping it, so the clean-up can remove it. Needs delete access. */
export const DELETE = route<Context>(async (request, context) => {
  const { eventId } = await context.params;
  const event = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => unkeepEvent(tx, eventId));
  return json({ event });
});
