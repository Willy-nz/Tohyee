import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { addSetup, addSystem, isSetupPart } from "@/lib/effluent/setup";
import { safetyPeopleMap } from "@/lib/safety/people";

type Context = { params: Promise<{ part: string }> };

/** POST: adds a system, pond, block, no-apply zone or consent (`systems`, `ponds`, `blocks`, `zones`, `consents`) to a farm. Owners and admins. */
export const POST = route<Context>(async (request, context) => {
  const { part } = await context.params;
  if (!isSetupPart(part)) throw new NotFoundError("Not found.");
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", async (tx) => (part === "systems" ? addSystem(tx, body, await safetyPeopleMap(tx.organisationId)) : addSetup(tx, part, body)));
  return json({ record }, { status: 201 });
});
