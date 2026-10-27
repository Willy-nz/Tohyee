import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { recordHistory } from "@/lib/safety/records";

type Context = { params: Promise<{ recordId: string }> };

/** GET: every version of a safety record, oldest first, with who entered each and when. */
export const GET = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const versions = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => recordHistory(tx, recordId));
  return json({ versions });
});
