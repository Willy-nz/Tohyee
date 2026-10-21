import { MAX_FILE_JSON_BYTES, json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listIrdDocuments } from "@/lib/tax/income/ird-documents";
import { createIrdImport, importedFigures, listIrdImports, listIrdMappings } from "@/lib/tax/income/ird-imports";

/** GET: imported IRD files with their rows, saved mappings, and (with `incomeYear`) the accepted figures for that year (ITX-IMP6 to ITX-IMP11). Owners and admins. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const incomeYear = params.get("incomeYear");
  const result = await withOrganisation(request, params.get("organisationId"), "admin", async (tx) => ({
    imports: await listIrdImports(tx),
    mappings: await listIrdMappings(tx),
    documents: (await listIrdDocuments(tx)).filter((document) => document.contentType === "application/pdf"),
    figures: incomeYear ? await importedFigures(tx, incomeYear) : null,
  }));
  return json(result);
});

/**
 * POST: imports a file through a mapping (`organisationId`, `idempotencyKey`,
 * `fileName`, `fileBase64`, `source`, `mapping`, optional `fileIncomeYear`,
 * `supportingDocumentId`, `saveMappingAs`). The file is kept as an IRD
 * document and each row waits for a person to accept or decline it
 * (ITX-IMP1 to ITX-IMP5). Owners and admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createIrdImport(tx, {
      idempotencyKey: body.idempotencyKey,
      fileName: body.fileName,
      fileBase64: body.fileBase64,
      source: body.source,
      mapping: body.mapping,
      fileIncomeYear: body.fileIncomeYear,
      supportingDocumentId: body.supportingDocumentId,
      saveMappingAs: body.saveMappingAs,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
