import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { disconnectStore, updateConnectionSettings } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/** Chooses what to sync and the posting settings (admins, SPC22). */
export const PATCH = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const connection = await withOrganisation(request, body.organisationId, "admin", (tx) => updateConnectionSettings(tx, connectionId, body));
  return json({ connection });
});

/**
 * Disconnects the store (admins, SPC9): its credentials and the links to its
 * records go; the contacts, items and sync log stay.
 */
export const DELETE = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const { organisation, actor } = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const connection = await disconnectStore(organisation, actor, connectionId);
  return json({ connection });
});
