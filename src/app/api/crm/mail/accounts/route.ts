import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAccounts } from "@/lib/crm/mail/service";

/** Every connected mailbox in the organisation, with who connected it and how its last sync went. */
export const GET = route(async (request) => {
  const accounts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listAccounts(tx));
  return json({ accounts });
});
