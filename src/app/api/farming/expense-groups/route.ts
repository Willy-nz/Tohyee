import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listExpenseGroups, setExpenseGroup } from "@/lib/farming/benchmarks";

/** Every expense account and its farm working expense group (FK1). */
export const GET = route(async (request) => {
  const accounts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listExpenseGroups(tx));
  return json({ accounts });
});

/** Puts an expense account (`accountCode`) in a group (`group`), or takes it out (`group` null). Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const accounts = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setExpenseGroup(tx, { accountCode: body.accountCode, group: body.group }));
  return json({ accounts });
});
