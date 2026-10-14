import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addAiFile, listAiFiles } from "@/lib/ai-workspace/files";

/** Files left for the AI to read (AIW3). */
export const GET = route(async (request) => {
  const files = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listAiFiles(tx));
  return json({ files });
});

/** Adds a file for the AI (`fileName`, `contentBase64`, optional `note`): CSV, text, JSON or Excel, up to 10 MB. Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const file = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addAiFile(tx, { fileName: body.fileName, contentBase64: body.contentBase64, note: body.note }));
  return json({ file }, { status: 201 });
});
