import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { productStock, recordProductStock } from "@/lib/farming/treatments";

/** GET: stock on hand of each chemical in Safety's register (`farmId` for one farm's), with its history (TRT7-TRT8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const products = await withFarmWork(request, params.get("organisationId"), "read", (tx) => productStock(tx, { farmId: params.get("farmId") }));
  return json({ products });
});

/** POST: product received, counted or thrown out (`chemicalRecordId`, `movementType`, `movedOn`, `quantity`, `unit`, `batch`, `expiresOn`, `note`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const products = await withFarmWork(request, body.organisationId, "record", (tx) => recordProductStock(tx, body));
  return json({ products }, { status: 201 });
});
