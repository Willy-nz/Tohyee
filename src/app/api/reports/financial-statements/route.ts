import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { financialStatementsPdf } from "@/lib/reports/financial-statements";

function asciiFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
}

/** GET: the year-end financial statements for the year ending `yearEnd`, as one PDF (FS1-FS3). Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const pdf = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => financialStatementsPdf(tx, { yearEnd: params.get("yearEnd") }));
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${asciiFileName(pdf.fileName)}"; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
