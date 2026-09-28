import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getHomeSummary } from "@/lib/reports/home";

/**
 * GET: Home for an organisation (examples H1-H4): bank accounts, money owed
 * to you, bills to pay and the next GST return. `today` (YYYY-MM-DD) is
 * optional; it defaults to today in the business time zone.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const summary = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    getHomeSummary(tx, { today: params.get("today") ?? undefined }),
  );
  return json(summary);
});
