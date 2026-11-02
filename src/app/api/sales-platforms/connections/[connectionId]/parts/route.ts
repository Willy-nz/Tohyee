import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { coverageFor, coverageKinds } from "@/lib/sales-platforms/coverage-status";
import { connectionCoverage } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/**
 * What each part of the connection has brought in (#532 part 2): Customers,
 * Products, Orders and Payouts, with counts and reasons. Viewers can read
 * it; it reads only this organisation's records, never the store.
 */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const params = searchParams(request);
  const { connection, facts } = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => connectionCoverage(tx, connectionId));
  return json({ parts: coverageKinds(connection.platform).map((kind) => coverageFor(kind, connection, facts)) });
});
