import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { canRecordSafety } from "@/lib/safety/records";
import { addChemical, listChemicals } from "@/lib/safety/register";

/** GET: a farm's hazardous substances inventory, with safety data sheets that need replacing marked. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => ({ chemicals: await listChemicals(tx, params.get("farmId")), canRecord: canRecordSafety(tx) }));
  return json(result);
});

/** Adds a chemical to a farm's inventory. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const chemical = await withFarmWork(request, body.organisationId, "read", (tx) => addChemical(tx, body));
  return json({ chemical }, { status: 201 });
});
