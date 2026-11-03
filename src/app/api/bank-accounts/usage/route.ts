import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAccountUsage } from "@/lib/bank/mixed-use";

/** GET: how each bank and credit card account is used (#545, MU1): business only, mixed use or personal. */
export const GET = route(async (request) => {
  const accounts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listAccountUsage(tx));
  return json({ accounts });
});
