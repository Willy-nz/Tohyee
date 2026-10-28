import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { DOCUMENT_LIMIT_BYTES, PHOTO_COPY_PIXELS } from "@/lib/offline/pack-inventory";
import { readSafetyFile } from "@/lib/safety/files";

/**
 * GET `?organisationId=&fileId=` (`&original=1` for the original): a safety
 * photo as a small copy (800 pixels on its longest side) or a document up
 * to 2 MB, for an offline farm pack (#472, decision 1003). Restricted files
 * are never given here, even to those who may see them online.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const file = await withFarmWork(request, params.get("organisationId"), "read", (tx) => readSafetyFile(tx, params.get("fileId")));
  if (file.restricted) throw new NotFoundError("Restricted files aren't kept offline.");
  const original = params.get("original") === "1";
  let content: Uint8Array = new Uint8Array(file.content);
  let contentType = file.contentType;
  let copy = false;
  if (!original && /^image\/(jpeg|png|webp)$/.test(file.contentType)) {
    try {
      const sharp = (await import("sharp")).default;
      content = new Uint8Array(await sharp(file.content).rotate().resize({ width: PHOTO_COPY_PIXELS, height: PHOTO_COPY_PIXELS, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer());
      contentType = "image/jpeg";
      copy = true;
    } catch {
      // No image library on this server: the original, if it's small enough.
    }
  }
  if (!original && !copy && content.byteLength > DOCUMENT_LIMIT_BYTES) {
    return Response.json({ error: "Too big to keep offline by default. Choose to keep originals on the Offline page.", code: "too_big", details: { sizeBytes: content.byteLength } }, { status: 413, headers: { "cache-control": "no-store" } });
  }
  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-tohyee-copy": copy ? "small" : "original",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
