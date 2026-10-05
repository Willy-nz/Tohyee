import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { createApprovalRule, listApprovalRules, organisationMembers } from "@/lib/approvals/rules";

/**
 * GET: approval rules (AW1), in the order they're tried, with `archived=true`
 * the archived ones, and the members who can approve (bookkeepers and above)
 * and claim. Viewers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const members = await organisationMembers(tx.organisationId);
    return {
      rules: await listApprovalRules(tx, { documentType: params.get("documentType"), archived: params.get("archived") }),
      approvers: members.filter((member) => roleAtLeast(member.role, "bookkeeper")).sort((left, right) => left.displayName.localeCompare(right.displayName)),
      claimants: members.filter((member) => roleAtLeast(member.role, "viewer")).sort((left, right) => left.displayName.localeCompare(right.displayName)),
    };
  });
  return json(result);
});

/** POST: adds a rule at the end of its document type's list. Admins. Returns warnings about steps that can get stuck (AW6). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => createApprovalRule(tx, membership.role, body));
  return json(result, { status: 201 });
});
