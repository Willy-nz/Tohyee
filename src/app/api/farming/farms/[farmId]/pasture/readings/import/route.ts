import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { importReadings, previewReadingImport } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** Imports cover readings from a CSV (`content`) or .xlsx (`contentBase64`), with optional `columns` and a `method` for the file. `preview: true` only shows what would happen (PF7). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64, columns: body.columns, method: body.method };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewReadingImport(tx, farmId, input));
    return json({ preview });
  }
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importReadings(tx, farmId, input));
  return json(result, { status: 201 });
});
