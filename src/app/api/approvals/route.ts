import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { listApprovalRequests } from "@/lib/approvals/requests";
import { submitForApproval } from "@/lib/approvals/service";

/**
 * GET: documents waiting for approval (AW3); `mine=true` only those the
 * signed-in person can approve or decline now, `finished=true` the latest
 * finished ones instead. Viewers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const requests = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { auth, membership }) =>
    listApprovalRequests(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, { mine: params.get("mine"), finished: params.get("finished") }),
  );
  return json({ requests });
});

/**
 * POST `{ documentType, documentId }`: submits a draft bill or purchase order
 * (or a claim) for approval under the first rule that matches it (AW3). It
 * stays a draft but can't be edited until it's withdrawn. Step 1's approvers
 * are emailed. Bookkeepers and above.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await publicOrigin(request);
  const { result, organisationId } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => ({
    result: await submitForApproval(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, body.documentType, body.documentId, { origin }),
    organisationId: membership.organisation.id,
  }));
  kickEmailOutbox(organisationId);
  return json({ request: result }, { status: 201 });
});
