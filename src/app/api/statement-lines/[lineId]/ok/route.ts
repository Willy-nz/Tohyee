import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { okStatementLine } from "@/lib/bank/confident";

type Context = { params: Promise<{ lineId: string }> };

/** POST: "OK" a line's confident suggestion (example BK18). `expect` is the suggestion's key as shown; a changed suggestion is refused (409). */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => okStatementLine(tx, lineId, body));
  return json(result, { status: result.created ? 201 : 200 });
});
