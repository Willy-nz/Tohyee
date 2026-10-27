import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { readSafetyFile } from "@/lib/safety/files";

type Context = { params: Promise<{ fileId: string }> };

/** GET: a safety photo or document, for those who may see it. */
export const GET = route<Context>(async (request, context) => {
  const { fileId } = await context.params;
  const file = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => readSafetyFile(tx, fileId));
  const safeName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-disposition": `inline; filename="${safeName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
