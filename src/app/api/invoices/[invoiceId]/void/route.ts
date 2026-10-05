import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidInvoice } from "@/lib/invoices/service";
import { refreshInvoiceLinks } from "@/lib/payments/links";

type Context = { params: Promise<{ invoiceId: string }> };

/** Voids an approved invoice: posts the exact reversal of its journal on `voidDate`. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const { result, organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => ({
    result: await voidInvoice(tx, invoiceId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  // PN10: a voided invoice's payment link is switched off.
  await refreshInvoiceLinks(organisation, actor, invoiceId);
  return json(result, { status: result.created ? 201 : 200 });
});
