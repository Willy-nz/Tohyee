import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAccountSales, recordAccountSale } from "@/lib/livestock/account-sales";

/** GET: stock agents' account sales, newest first. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const accountSales = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listAccountSales(tx));
  return json({ accountSales });
});

/** Enters an agent's account sale once: invoice, deductions bill, contra and sale movements (LV13-LV15). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recordAccountSale(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      reference: body.reference,
      saleDate: body.saleDate,
      dueDate: body.dueDate,
      lines: body.lines,
      deductions: body.deductions,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
