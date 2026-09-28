import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { publishCustomReport } from "@/lib/reports/custom";

type Context = { params: Promise<{ reportId: string }> };

/** Keeps a frozen copy of the draft, with its figures as they are now (example CR7). */
export const POST = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    publishCustomReport(tx, reportId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
