import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { mobFromGrazings, untypedMobs } from "@/lib/farming/mobs";

type Context = { params: Promise<{ farmId: string }> };

/** GET: mob names typed on grazings without a mob record (MOB9). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const mobs = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => untypedMobs(tx, { farmId }));
  return json({ mobs });
});

/** Makes a mob record from a typed mob name (`mob`, `kind`, `classCode`, `head`). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => mobFromGrazings(tx, { ...body, farmId }));
  return json(result, { status: 201 });
});
