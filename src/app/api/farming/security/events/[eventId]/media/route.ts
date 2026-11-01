import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { mediaFor } from "@/lib/security-cameras/events";
import { parseRange } from "@/lib/security-cameras/range";
import { resolveStored, thumbnailPathFor } from "@/lib/security-cameras/storage";

type Context = { params: Promise<{ eventId: string }> };

/**
 * GET `?variant=thumbnail` (a small photo; the full photo when there's no
 * small copy), `?variant=full` (the photo or clip, with byte ranges so a
 * clip plays and seeks) or `?download=1` (as a file to keep). Every request
 * is checked like the event itself: camera access, the farm, and download
 * access for downloads, which are audited (decision 1223).
 */
export const GET = route<Context>(async (request, context) => {
  const { eventId } = await context.params;
  const params = searchParams(request);
  const download = params.get("download") === "1";
  const purpose = download ? "download" : params.get("variant") === "thumbnail" ? "thumbnail" : "view";
  const rangeHeader = request.headers.get("range");
  const startsPlaying = !rangeHeader || /^bytes=0-/.test(rangeHeader.trim());
  let organisationId = "";
  const media = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => {
    organisationId = tx.organisationId;
    return mediaFor(tx, eventId, purpose, { startsPlaying });
  });
  let file = resolveStored(organisationId, media.storagePath);
  let contentType = media.contentType;
  if (purpose === "thumbnail" && media.event.hasThumbnail) {
    file = resolveStored(organisationId, thumbnailPathFor(media.storagePath));
    contentType = "image/jpeg";
  }
  const size = await stat(file).then((found) => found.size).catch(() => null);
  if (size === null) throw new NotFoundError("That file isn't on the server any more.");
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "accept-ranges": "bytes",
  };
  if (download) {
    const stamp = media.event.occurredAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const safeCamera = media.event.cameraName.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "camera";
    headers["content-disposition"] = `attachment; filename="${safeCamera}-${stamp}.${contentType === "video/mp4" ? "mp4" : "jpg"}"`;
  }
  const range = download ? null : parseRange(rangeHeader, size);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { ...headers, "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
  });
});
