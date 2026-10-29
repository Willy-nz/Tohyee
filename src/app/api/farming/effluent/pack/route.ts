import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { loadCouncilPack, renderCouncilPack } from "@/lib/effluent/pack";

function asciiFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
}

/**
 * GET: the council pack (#487, decision 1099a) for `farmId` and `from`..`to`,
 * as a zip to download. Viewers and above on their farms; not Farm staff.
 * Tohyee never sends it anywhere.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const data = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => loadCouncilPack(tx, { farmId: params.get("farmId"), from: params.get("from"), to: params.get("to") }));
  const pack = await renderCouncilPack(data);
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
