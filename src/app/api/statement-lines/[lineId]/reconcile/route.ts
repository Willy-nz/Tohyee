import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { reconcileStatementLine } from "@/lib/bank/reconcile";

type Context = { params: Promise<{ lineId: string }> };

/**
 * Reconciles a line. `kind`: match (`journalLineIds`), payments (`allocations`
 * of `{ invoiceId | billId, amount }`), bank_transaction (`contactId`,
 * `amountsMode`, `lines`, `reference`) or transfer (`otherAccountCode`).
 * Match and payments take an optional `adjustment` (`accountCode`,
 * `taxCode`, `contactId`, `description`) for a small difference (BK24, BK25).
 */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    reconcileStatementLine(tx, lineId, body),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
