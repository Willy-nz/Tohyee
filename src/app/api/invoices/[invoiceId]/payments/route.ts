import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listPayments, recordPayment } from "@/lib/invoices/payments";
import { refreshInvoiceLinks } from "@/lib/payments/links";

type Context = { params: Promise<{ invoiceId: string }> };

/** GET: the invoice's payments, active and voided, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const params = searchParams(request);
  const payments = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listPayments(tx, invoiceId),
  );
  return json({ payments });
});

/**
 * Records a payment against an approved invoice: posts Dr the bank account /
 * Cr accounts receivable on `paymentDate`. It can't be more than the amount due.
 */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const { result, organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => ({
    result: await recordPayment(tx, invoiceId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      paymentDate: body.paymentDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
      exchangeRate: body.exchangeRate,
    }),
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  // PN5: the amount due changed, so the old payment link is switched off.
  await refreshInvoiceLinks(organisation, actor, invoiceId);
  return json(result, { status: result.created ? 201 : 200 });
});
