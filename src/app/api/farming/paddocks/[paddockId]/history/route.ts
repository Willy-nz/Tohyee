import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { paddockHistory } from "@/lib/farming/soil";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: the paddock's soil tests and fertiliser applications, newest first. */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const history = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => paddockHistory(tx, paddockId));
  return json({ history });
});
