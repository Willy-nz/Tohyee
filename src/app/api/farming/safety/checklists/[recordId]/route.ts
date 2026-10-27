import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { changeChecklist } from "@/lib/safety/equipment";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of a checklist. Checks already done keep the questions they were asked. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const checklist = await withOrganisation(request, body.organisationId, "viewer", (tx) => changeChecklist(tx, recordId, body));
  return json({ checklist });
});
