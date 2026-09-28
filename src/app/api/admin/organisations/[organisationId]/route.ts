import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { updateOrganisation } from "@/lib/organisations/admin";

export const PATCH = route<{ params: Promise<{ organisationId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { organisationId } = await context.params;
  const body = await readJson(request);
  const organisation = await updateOrganisation(auth.user, organisationId, {
    displayName: body.displayName,
    isActive: body.isActive,
  });
  return json({ organisation });
});
