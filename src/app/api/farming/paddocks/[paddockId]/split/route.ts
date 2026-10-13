import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { splitPaddock } from "@/lib/farming/paddocks";

type Context = { params: Promise<{ paddockId: string }> };

/** Splits a paddock on `onDate` into `parts` (each a `name`, `effectiveHa` and optional `geometry`). Its history stays with it (FB7). */
export const POST = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const body = await readJson(request);
  const paddocks = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => splitPaddock(tx, paddockId, { onDate: body.onDate, parts: body.parts }));
  return json({ paddocks }, { status: 201 });
});
