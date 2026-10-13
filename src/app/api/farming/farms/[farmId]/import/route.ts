import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { importBoundaries, previewBoundaryImport } from "@/lib/farming/paddocks";

type Context = { params: Promise<{ farmId: string }> };

/**
 * Imports a file of paddock shapes: GeoJSON or KML as text (`content`), or a
 * KMZ or zipped shapefile as base64 (`contentBase64`), with `fileName` and which
 * properties hold the name and effective area). `preview: true` only shows
 * what would happen. The same file can't be imported twice.
 */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const input = { fileName: body.fileName, content: body.content, contentBase64: body.contentBase64, nameProperty: body.nameProperty, effectiveProperty: body.effectiveProperty, onDate: body.onDate };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewBoundaryImport(tx, farmId, input));
    return json({ preview });
  }
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importBoundaries(tx, farmId, input));
  return json(result, { status: 201 });
});
