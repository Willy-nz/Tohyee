import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { retryProvisioning } from "@/lib/organisations/admin";

/**
 * Retries database set-up or an upgrade that failed. Safe to run on a healthy
 * organisation too (every step is idempotent).
 */
export const POST = route<{ params: Promise<{ organisationId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { organisationId } = await context.params;
  return json({ organisation: await retryProvisioning(auth.user, organisationId) });
});
