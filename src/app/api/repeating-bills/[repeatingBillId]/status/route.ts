import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setRepeatingBillStatus } from "@/lib/repeating/bills";

type Context = { params: Promise<{ repeatingBillId: string }> };

/** Pauses (active -> paused), resumes (paused -> active) or ends a template. Ending is final. */
export const POST = route<Context>(async (request, context) => {
  const { repeatingBillId } = await context.params;
  const body = await readJson(request);
  const repeatingBill = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setRepeatingBillStatus(tx, repeatingBillId, body.status),
  );
  return json({ repeatingBill });
});
