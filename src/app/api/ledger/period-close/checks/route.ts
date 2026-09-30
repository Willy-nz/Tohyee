import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { periodChecklist } from "@/lib/ledger/period-close";

/** The period close checklist for the month ending `periodEnd` (PC2-PC9). Posts nothing. Viewers. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const checklist = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    periodChecklist(tx, { periodEnd: params.get("periodEnd") }),
  );
  return json({ checklist });
});
