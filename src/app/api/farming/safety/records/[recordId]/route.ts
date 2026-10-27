import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { recordHistory } from "@/lib/safety/records";

type Context = { params: Promise<{ recordId: string }> };

/** GET: every version of a safety record, oldest first, with who entered each and when. */
export const GET = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const versions = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => recordHistory(tx, recordId));
  return json({ versions });
});
