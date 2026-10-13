import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { importSoilTests, previewSoilImport } from "@/lib/farming/soil";

type Context = { params: Promise<{ farmId: string }> };

/**
 * Imports a lab's file of soil tests: CSV (`content`) or an .xlsx workbook
 * (`contentBase64`), with optional column choices, a date for the whole file
 * and the lab's name. `preview: true` only shows what would happen. The same
 * file can't be imported twice.
 */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64, columns: body.columns, sampledOn: body.sampledOn, lab: body.lab };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewSoilImport(tx, farmId, input));
    return json({ preview });
  }
  const tests = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importSoilTests(tx, farmId, input));
  return json({ tests }, { status: 201 });
});
