import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeChemical } from "@/lib/safety/register";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of a chemical: `step` update, correct or withdraw; `removed` with why when it's gone from the farm. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const chemical = await withFarmWork(request, body.organisationId, "read", (tx) => changeChemical(tx, recordId, body));
  return json({ chemical });
});
