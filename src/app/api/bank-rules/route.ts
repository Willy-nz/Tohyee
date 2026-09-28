import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBankRule, listBankRules } from "@/lib/bank/rules";

export const GET = route(async (request) => {
  const rules = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listBankRules(tx));
  return json({ rules });
});

/** Adds a bank rule: text to look for, and the bank transaction to suggest. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const rule = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createBankRule(tx, body));
  return json({ rule }, { status: 201 });
});
