import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { importMobs, previewMobImport } from "@/lib/farming/mobs";

type Context = { params: Promise<{ farmId: string }> };

/** Previews (`preview: true`) or imports a CSV or .xlsx of mobs already on the farm. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64 };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewMobImport(tx, farmId, input));
    return json({ preview });
  }
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importMobs(tx, farmId, input));
  return json(result);
});
