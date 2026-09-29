import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTimeEntry } from "@/lib/projects/service";

type Context = { params: Promise<{ entryId: string }> };

/** Changes an unbilled time entry: yours, or anyone's for an admin (PJ8). */
export const PUT = route<Context>(async (request, context) => {
  const { entryId } = await context.params;
  const body = await readJson(request);
  const entry = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    updateTimeEntry(tx, membership.role, entryId, { taskId: body.taskId, entryDate: body.entryDate, hours: body.hours, minutes: body.minutes, description: body.description }),
  );
  return json({ entry });
});
