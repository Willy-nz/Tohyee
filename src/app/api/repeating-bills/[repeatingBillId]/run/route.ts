import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { runRepeatingBillNow } from "@/lib/repeating/bills";

type Context = { params: Promise<{ repeatingBillId: string }> };

/** Makes this template's bills that are due up to today now, as the hourly job would. */
export const POST = route<Context>(async (request, context) => {
  const { repeatingBillId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => runRepeatingBillNow(tx, repeatingBillId));
  return json(result);
});
