import { json, MAX_FILE_JSON_BYTES, readJson, route, withFarmWork } from "@/lib/api/http";
import { uploadSafetyFile } from "@/lib/safety/files";

/** Keeps a photo or PDF for a safety record: `farmId`, `fileName`, `contentType`, `contentBase64`, `phoneFileTime`, `restricted`; from the phone's queue also `operationId` (the file's id, so sending it again finds it) and `place` (#472). */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const file = await withFarmWork(request, body.organisationId, "read", (tx) => uploadSafetyFile(tx, body));
  return json({ file }, { status: 201 });
});
