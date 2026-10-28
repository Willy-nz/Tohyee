import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addIncidentAction } from "@/lib/effluent/care";
import { safetyPeopleMap } from "@/lib/safety/people";

type Context = { params: Promise<{ recordId: string }> };

/** POST: another action on an incident (`title`, `assignedToUserId` or `assignedToName`, `due`). Marked done and checked in Safety. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const action = await withFarmWork(request, body.organisationId, "read", async (tx) => addIncidentAction(tx, recordId, body, await safetyPeopleMap(tx.organisationId)));
  return json({ action }, { status: 201 });
});
