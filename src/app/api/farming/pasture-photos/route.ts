import { json, MAX_FILE_JSON_BYTES, readJson, route, withFarmWork } from "@/lib/api/http";
import { uploadPasturePhoto } from "@/lib/farming/pasture-photos";

/** Keeps a paddock photo (#503): `farmId`, `paddockId`, `fileName`, `contentType`, `contentBase64`, `phoneFileTime`, `place`, `note`; from the phone's queue also `operationId` (the photo's id, so sending it again finds it) and `readingOperationId` (the Log reading it was taken with). Like a cover reading: farm staff, bookkeepers and above (decision 1160). */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const photo = await withFarmWork(request, body.organisationId, "record", (tx) => uploadPasturePhoto(tx, body));
  return json({ photo }, { status: 201 });
});
