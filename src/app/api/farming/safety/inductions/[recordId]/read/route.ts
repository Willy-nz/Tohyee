import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { inductionToRead } from "@/lib/safety/inductions";

type Context = { params: Promise<{ recordId: string }> };

/** GET: an induction to read before signing, with the farm's current hazards and emergency details. */
export const GET = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const params = searchParams(request);
  const toRead = await withFarmWork(request, params.get("organisationId"), "read", (tx) => inductionToRead(tx, recordId, params.get("farmId")));
  return json(toRead);
});
