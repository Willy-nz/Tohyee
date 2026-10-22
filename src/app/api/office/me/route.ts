import { roleAtLeast } from "@/lib/auth/roles";
import { json, officeIdentity, officeRoute } from "@/lib/office/api";
import { listMembershipsForUser } from "@/lib/organisations/registry";

/**
 * GET: who the PowerPoint add-in is signed in as, and the organisations they
 * can open Analytics in (report viewer and up, ready to use), for choosing
 * what to show on a slide (#429, decision 837).
 */
export const GET = officeRoute(async (request) => {
  const identity = await officeIdentity(request);
  const memberships = await listMembershipsForUser(identity.user.id);
  const organisations = memberships
    .filter((membership) => roleAtLeast(membership.role, "report_viewer") && membership.organisation.provisioningStatus === "ready" && membership.organisation.migrationStatus === "current")
    .map((membership) => ({ id: membership.organisation.id, displayName: membership.organisation.displayName, role: membership.role }));
  return json({ user: { email: identity.user.email, displayName: identity.user.displayName }, organisations });
});
