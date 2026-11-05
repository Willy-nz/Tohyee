import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { defaultProviderFactory } from "@/lib/farming/vegetation/jobs";
import { requireProviderAllowed } from "@/lib/farming/vegetation/http";
import { disconnect, parseConnection, saveConnection } from "@/lib/farming/vegetation/service";

/**
 * Tests a connection (decision 1539) and, unless `testOnly`, saves it when
 * it works. The secret goes to the provider's sign-in only, is stored
 * encrypted and is never sent back. Owners and admins. The test is made
 * between transactions, never inside one.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const connection = parseConnection(body);
  await withOrganisation(request, body.organisationId, "admin", async (_tx, { membership }) => requireProviderAllowed(membership.organisation, connection.provider));
  const check = await defaultProviderFactory(connection).checkConnection();
  if (!check.ok) return json({ ok: false, problem: check.reason, message: check.message }, { status: 200 });
  if (body.testOnly === true) return json({ ok: true });
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => saveConnection(tx, connection));
  return json({ ok: true, settings });
});

/** Disconnects: the secret is deleted and fetching stops. What was worked out stays. */
export const DELETE = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => disconnect(tx));
  return json({ settings });
});
