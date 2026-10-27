import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { safetyPeopleMap } from "@/lib/safety/people";
import { changeAction } from "@/lib/safety/reports";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of an action: `step` is update, done, verify, reopen or withdraw, with `expectedVersion`. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const action = await withOrganisation(request, body.organisationId, "viewer", async (tx) => changeAction(tx, recordId, body, await safetyPeopleMap(tx.organisationId)));
  return json({ action });
});
