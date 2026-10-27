import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { loadPackData, renderPack } from "@/lib/safety/pack";

function asciiFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
}

/**
 * GET: the WorkSafe pack (#446, decision 934) for `farmId` (or all the
 * person's farms) and `from`..`to`, as a zip. Viewers and above, on their
 * farms; restricted details only for those who may see them.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const data = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => loadPackData(tx, { farmId: params.get("farmId"), from: params.get("from"), to: params.get("to") }));
  const pack = await renderPack(data);
  return new Response(new Uint8Array(pack.bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${asciiFileName(pack.fileName)}"; filename*=UTF-8''${encodeURIComponent(pack.fileName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
