import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { uploadSafetyFile } from "@/lib/safety/files";

/** Keeps a photo or PDF for a safety record: `farmId`, `fileName`, `contentType`, `contentBase64`, `phoneFileTime`, `restricted`. */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const file = await withOrganisation(request, body.organisationId, "viewer", (tx) => uploadSafetyFile(tx, body));
  return json({ file }, { status: 201 });
});
