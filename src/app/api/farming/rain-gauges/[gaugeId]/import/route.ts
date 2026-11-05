import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { importRainReadings, previewRainImport } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ gaugeId: string }> };

/** Imports a gauge's readings from a CSV (`content`) or .xlsx (`contentBase64`), with optional `columns` ({ date, mm }). `preview: true` only shows what would happen. Bookkeepers and up (RF7). */
export const POST = route<Context>(async (request, context) => {
  const { gaugeId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64, columns: body.columns };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewRainImport(tx, gaugeId, input));
    return json({ preview });
  }
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importRainReadings(tx, gaugeId, input));
  return json(result, { status: 201 });
});
