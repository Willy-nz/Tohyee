import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeTimeEntry } from "@/lib/projects/service";

type Context = { params: Promise<{ entryId: string }> };

/** Removes an unbilled time entry (it's kept, marked removed). */
export const POST = route<Context>(async (request, context) => {
  const { entryId } = await context.params;
  const body = await readJson(request);
  const entry = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => removeTimeEntry(tx, membership.role, entryId));
  return json({ entry });
});
