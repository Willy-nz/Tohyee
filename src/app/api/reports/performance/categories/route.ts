import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAccountCategories, setAccountCategory } from "@/lib/reports/performance-report";

/** Every account's performance report category, chosen or suggested (NPR). */
export const GET = route(async (request) => {
  const accounts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listAccountCategories(tx));
  return json({ accounts });
});

/** Chooses an account's category (`accountCode`, `category`, optional `cashCategory`); a blank category goes back to the suggestion. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const accounts = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setAccountCategory(tx, { accountCode: body.accountCode, category: body.category, cashCategory: body.cashCategory }),
  );
  return json({ accounts });
});
