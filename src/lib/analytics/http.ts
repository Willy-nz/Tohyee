import { requireAuth } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import type { Actor } from "@/lib/db/org-transaction";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { parseOrganisationId } from "@/lib/organisations/registry";

/**
 * For analytics routes that do work outside one organisation transaction
 * (reading files, loading DuckDB): the signed-in member, their organisation
 * and who they are.
 */
export async function analyticsMember(
  request: Request,
  organisationIdInput: unknown,
  minimumRole: Role,
): Promise<{ organisation: OrganisationRecord; actor: Actor; role: Role }> {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(organisationIdInput);
  const membership = await requireOrganisationRole(auth, organisationId, minimumRole);
  return { organisation: membership.organisation, actor: { userId: auth.user.id, email: auth.user.email }, role: membership.role };
}
