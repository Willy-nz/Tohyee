import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { testConnection } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/** "Test connection" (admins): tries the stored credentials, outside any database transaction. */
export const POST = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await testConnection(organisation, actor, connectionId, { webhookOrigin: await publicOrigin(request) });
  return json({ result });
});
