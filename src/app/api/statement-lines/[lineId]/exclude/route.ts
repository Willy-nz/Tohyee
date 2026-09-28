import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setStatementLineExcluded } from "@/lib/bank/accounts";
import { requireBoolean } from "@/lib/validation";

type Context = { params: Promise<{ lineId: string }> };

/** Excludes an unreconciled line (`excluded: true`), or brings an excluded one back (`excluded: false`). */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const line = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setStatementLineExcluded(tx, lineId, requireBoolean(body.excluded, "excluded")),
  );
  return json({ line });
});
