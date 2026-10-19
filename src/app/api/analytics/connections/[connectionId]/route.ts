import { json, readJson, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { checkConnectionInput, deleteConnection, getConnection, requireAnalyticsOn, saveConnectionChanges, settingsOf } from "@/lib/analytics/databases/connections";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

type Context = { params: Promise<{ connectionId: string }> };

function idFrom(value: string): string {
  return /^[1-9]\d{0,17}$/.test(value) ? value : "0";
}

/** Changes a connection: it's tested first, and a new server, database or user needs the password again. Admins and owners. */
export const PATCH = route<Context>(async (request, context) => {
  const id = idFrom((await context.params).connectionId);
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const current = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalyticsOn(tx);
    return getConnection(tx, id);
  }, { readOnly: true });
  // Fields left out keep their saved values.
  const merged = { ...settingsOf(current), ...body, engine: current.engine };
  const checked = await checkConnectionInput(organisation, actor, merged, id);
  const connection = await withOrganisationTransaction(organisation, actor, (tx) => saveConnectionChanges(tx, id, body, checked.settings, checked.password));
  return json({ connection, test: checked.result });
});

/** Removes a connection that no source uses. */
export const DELETE = route<Context>(async (request, context) => {
  const id = idFrom((await context.params).connectionId);
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await withOrganisationTransaction(organisation, actor, (tx) => deleteConnection(tx, id));
  return json({ ok: true });
});
