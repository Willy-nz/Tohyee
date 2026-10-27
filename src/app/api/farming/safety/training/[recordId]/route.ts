import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { safetyPeopleMap } from "@/lib/safety/people";
import { changeTraining } from "@/lib/safety/register";

type Context = { params: Promise<{ recordId: string }> };

/** A new version: `step` update, correct, withdraw, or confirm (only the person it's about). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const training = await withOrganisation(request, body.organisationId, "viewer", async (tx) => changeTraining(tx, recordId, body, await safetyPeopleMap(tx.organisationId)));
  return json({ training });
});
