import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { connectStore, listConnections } from "@/lib/sales-platforms/service";

/** The organisation's sales platform connections (examples SPC1, SPC10). Viewers can read them. */
export const GET = route(async (request) => {
  const connections = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listConnections(tx));
  return json({ connections });
});

/**
 * Connects a store (admins, SPC1). The store is called outside any database
 * transaction: the role is checked first, then the credentials are tried,
 * then they're stored encrypted.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const connection = await connectStore(organisation, actor, body, { webhookOrigin: await publicOrigin(request) });
  return json({ connection });
});
