import { json, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { readPasturePhoto, removePasturePhoto } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ photoId: string }> };

/** GET: a paddock photo, for those who may see its farm's readings. */
export const GET = route<Context>(async (request, context) => {
  const { photoId } = await context.params;
  const photo = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => readPasturePhoto(tx, photoId));
  const safeName = photo.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(photo.content), {
    status: 200,
    headers: {
      "content-type": photo.contentType,
      "content-disposition": `inline; filename="${safeName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

/** Removes a photo added by mistake (bookkeepers and above, like a reading); it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { photoId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removePasturePhoto(tx, photoId));
  return json({ ok: true });
});
