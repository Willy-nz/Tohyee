import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { importApplications, previewApplicationImport } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/**
 * Imports a CSV of applications (`fileName`, `content`; columns Paddock,
 * Product, Date, Tonnes and optionally Treated ha). `preview: true` only
 * shows what would happen. The same file can't be imported twice.
 */
export const POST = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const input = { fileName: body.fileName, content: body.content };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewApplicationImport(tx, planId, input));
    return json({ preview });
  }
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importApplications(tx, planId, input));
  return json({ report }, { status: 201 });
});
