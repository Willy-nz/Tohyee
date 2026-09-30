import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { exportCsv } from "@/lib/import/service";

/** The chart of accounts, contacts or products and services as CSV (`kind`), in the columns the import reads. Admins. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "admin", (tx) => exportCsv(tx, params.get("kind")));
  return new Response(file.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
