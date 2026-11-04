import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { importGrazings, previewGrazingImport } from "@/lib/farming/timeline";

type Context = { params: Promise<{ farmId: string }> };

/** Previews (`preview: true`) or imports a CSV or .xlsx of grazing history (TL3). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64 };
  if (body.preview === true) return json({ preview: await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewGrazingImport(tx, farmId, input)) });
  return json(await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importGrazings(tx, farmId, input)));
});
