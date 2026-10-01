import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listBankFileSettings, setBankFileSetting } from "@/lib/payroll/bank-file-service";

/**
 * Settings › Bank files (PBF7): each NZD bank account's account number and
 * bank file format. Bookkeepers and above can see them; only admins change
 * them. The organisation's own account isn't payroll data, so this doesn't
 * need payroll access; making a file does.
 */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => listBankFileSettings(tx));
  return json(settings);
});

/** Body: { organisationId, accountId, format ("anz_domestic_extended", "asb_mt9", "bnz_ib4b" or null to clear), accountNumber }. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const setting = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setBankFileSetting(tx, body.accountId, { format: body.format, accountNumber: body.accountNumber }),
  );
  return json({ setting });
});
