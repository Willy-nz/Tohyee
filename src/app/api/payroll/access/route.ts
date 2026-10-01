import { json, readJson, requireAuth, route, searchParams, withOrganisation } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { listMembers } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { listPayrollAccess, setPayrollAccess } from "@/lib/payroll/access";

/** Who has payroll access, and giving or removing it (examples PE9-PE12). Admins only. */

async function adminMembers(request: Request, organisationIdInput: unknown) {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(organisationIdInput);
  await requireOrganisationRole(auth, organisationId, "admin");
  // Members come from the core database, read before the organisation's transaction opens.
  return { organisationId, members: await listMembers(organisationId) };
}

export const GET = route(async (request) => {
  const { organisationId, members } = await adminMembers(request, searchParams(request).get("organisationId"));
  const people = await withOrganisation(request, organisationId, "admin", (tx) => listPayrollAccess(tx, members));
  return json({ people });
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const { organisationId, members } = await adminMembers(request, body.organisationId);
  const people = await withOrganisation(request, organisationId, "admin", (tx) =>
    setPayrollAccess(tx, members, { userId: body.userId, hasPayrollAccess: body.hasPayrollAccess }),
  );
  return json({ people });
});
