import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { listAccounts } from "@/lib/crm/mail/service";

/** Every connected mailbox in the organisation, with who connected it and how its last sync went. */
export const GET = route(async (request) => {
  const accounts = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx) => listAccounts(tx));
  return json({ accounts });
});
