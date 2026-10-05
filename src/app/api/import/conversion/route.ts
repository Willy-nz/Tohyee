import { MAX_FILE_JSON_BYTES, json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { conversionStatus, importConversion } from "@/lib/import/conversion";

/** The opening balances brought in, and the trial balance at the conversion date beside them (IM12). Admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => conversionStatus(tx));
  return json({ status });
});

/**
 * Checks (`commit` false) or posts (`commit` true) the opening balances: the
 * trial balance, open invoices and bills, and stock on hand, as at the
 * conversion date, all together, once. Admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => importConversion(tx, body, body.commit === true));
  return json({ result }, { status: result.committed ? 201 : 200 });
});
