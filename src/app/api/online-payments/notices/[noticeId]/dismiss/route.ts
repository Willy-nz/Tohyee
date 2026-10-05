import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { dismissOnlinePaymentNotice } from "@/lib/payments/stripe";

type Context = { params: Promise<{ noticeId: string }> };

/** POST: puts away a payment notice a person has dealt with (PN10). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { noticeId } = await context.params;
  const body = await readJson(request);
  const payments = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => dismissOnlinePaymentNotice(tx, noticeId));
  return json({ payments });
});
