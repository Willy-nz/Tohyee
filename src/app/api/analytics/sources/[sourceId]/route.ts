import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { removeSource, updateSource } from "@/lib/analytics/sources";

type Context = { params: Promise<{ sourceId: string }> };

function sourceIdFrom(value: string): string {
  return /^\d{1,18}$/.test(value) ? value : "0";
}

export const PATCH = route<Context>(async (request, context) => {
  const sourceId = sourceIdFrom((await context.params).sourceId);
  const body = await readJson(request);
  const source = await withOrganisation(request, body.organisationId, "admin", (tx) => updateSource(tx, sourceId, body));
  return json({ source });
});

/** Removes the source and its loaded table; the load history stays. */
export const DELETE = route<Context>(async (request, context) => {
  const sourceId = sourceIdFrom((await context.params).sourceId);
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await removeSource(organisation, actor, sourceId);
  return json({ ok: true });
});
