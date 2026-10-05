import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { documentApproval } from "@/lib/approvals/service";

/** GET `?documentType&documentId`: the rule that applies to a document, and its waiting or latest approval request. Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const approval = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { auth, membership }) =>
    documentApproval(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, params.get("documentType"), params.get("documentId")),
  );
  return json({ approval });
});
