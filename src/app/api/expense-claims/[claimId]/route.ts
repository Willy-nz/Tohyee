import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteExpenseClaim, getExpenseClaim, updateExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** GET: the claim with its receipts and payments. */
export const GET = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const claim = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getExpenseClaim(tx, claimId));
  return json({ claim });
});

/** Changes a draft's description or receipts. Only its claimant can. */
export const PUT = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const claim = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateExpenseClaim(tx, claimId, { description: body.description, receipts: body.receipts }),
  );
  return json({ claim });
});

/** Deletes a draft. Only its claimant can. */
export const DELETE = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteExpenseClaim(tx, claimId));
  return json({ ok: true });
});
