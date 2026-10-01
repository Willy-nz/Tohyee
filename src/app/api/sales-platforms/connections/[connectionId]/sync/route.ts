import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { syncConnection } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/** "Sync now" (admins). The store is called outside any database transaction. */
export const POST = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncConnection(organisation, connectionId, actor);
  return json({ result });
});
