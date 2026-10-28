import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { changeSetup, isSetupPart } from "@/lib/effluent/setup";

type Context = { params: Promise<{ part: string; recordId: string }> };

/** PATCH: a new version of a setup record (`step`: update, correct or withdraw, with `why`; `expectedVersion`). Owners and admins. */
export const PATCH = route<Context>(async (request, context) => {
  const { part, recordId } = await context.params;
  if (!isSetupPart(part)) throw new NotFoundError("Not found.");
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => changeSetup(tx, part, recordId, body));
  return json({ record });
});
