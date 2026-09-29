import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { journalReport } from "@/lib/reports/journal-report";

/** Every journal posted from `from` to `to`, with its lines, source and who posted it (examples JR1-JR3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    journalReport(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
