import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeInduction } from "@/lib/safety/inductions";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of an induction (`expectedVersion`; `needsResign` asks everyone to sign again; `change` corrected or withdrawn with `why`). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const induction = await withFarmWork(request, body.organisationId, "read", (tx) => changeInduction(tx, recordId, body));
  return json({ induction });
});
