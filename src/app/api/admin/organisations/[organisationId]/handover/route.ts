import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { cancelHandover, requestHandover } from "@/lib/organisations/handover";

type Context = { params: Promise<{ organisationId: string }> };

/** POST `{ email, reason }`: hand the organisation over to someone else after a 7-day wait (#208). Server admins, on the server computer. */
export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { organisationId } = await context.params;
  const body = await readJson(request);
  return json({ handover: await requestHandover(auth.user, organisationId, { email: body.email, reason: body.reason }) }, { status: 201 });
});

/** DELETE: cancels the waiting handover. */
export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { organisationId } = await context.params;
  return json({ handover: await cancelHandover(auth.user, organisationId, "server_admin") });
});
