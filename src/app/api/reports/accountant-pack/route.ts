import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { buildAccountantPack } from "@/lib/reports/accountant-pack";

function asciiFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
}

/**
 * GET: the year-end accountant pack for the financial year ending `yearEnd`
 * (#258), as a ZIP: trial balance, profit and loss, balance sheet and
 * general ledger (CSV) and each bank account's reconciliation (PDF). The
 * same reports as the screens, so the same access (viewer and above).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const pack = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => buildAccountantPack(tx, { yearEnd: params.get("yearEnd") }));
  return new Response(new Uint8Array(pack.bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      // Header values are ASCII: macrons (Kōwhai) become plain letters there, and the exact name goes in filename*.
      "content-disposition": `attachment; filename="${asciiFileName(pack.fileName)}"; filename*=UTF-8''${encodeURIComponent(pack.fileName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
