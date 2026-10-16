import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listIr10Accounts, setIr10Account } from "@/lib/tax/income/ir10";

/** GET: each account's IR10 box and role (owners and admins; ITX19). */
export const GET = route(async (request) => {
  const accounts = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => listIr10Accounts(tx));
  return json({ accounts });
});

/** PUT: chooses an account's IR10 box and role (owners and admins; ITX19). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const account = await withOrganisation(request, body.organisationId, "admin", (tx) => setIr10Account(tx, { accountId: body.accountId, box: body.box, role: body.role }));
  return json({ account });
});
