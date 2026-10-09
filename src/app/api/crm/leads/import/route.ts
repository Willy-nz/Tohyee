import { json, readJson, route, withCrm } from "@/lib/api/http";
import { importLeads } from "@/lib/crm/leads";

/** Imports leads from a CSV or Excel file (`fileName`, `fileBase64`, `idempotencyKey`), decision 492. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    importLeads(tx, { fileName: body.fileName, fileBase64: body.fileBase64, idempotencyKey: body.idempotencyKey, source: body.source }, scope),
  );
  return json(result, { status: result.created > 0 ? 201 : 200 });
});
