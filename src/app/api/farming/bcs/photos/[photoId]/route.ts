import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { setReference } from "@/lib/farming/bcs";

type Context = { params: Promise<{ photoId: string }> };

/** PATCH `{ reference: true, score? }` marks a photo as a reference for a score given by eye; `{ reference: false }` clears it (decision 1493). */
export const PATCH = route<Context>(async (request, context) => {
  const { photoId } = await context.params;
  const body = await readJson(request);
  const photo = await withFarmWork(request, body.organisationId, "record", (tx) => setReference(tx, photoId, { score: body.score, clear: body.reference === false }));
  return json({ photo });
});
