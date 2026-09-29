import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { invoiceProject } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Makes a draft invoice from chosen unbilled time, fixed prices and expenses (PJ6). */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    invoiceProject(tx, projectId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate,
      accountCode: body.accountCode,
      taxCode: body.taxCode,
      timeEntryIds: body.timeEntryIds,
      taskIds: body.taskIds,
      expenseIds: body.expenseIds,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
