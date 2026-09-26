import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getJournalDetails } from "@/lib/ledger/journals";

export const GET = route<{ params: Promise<{ journalId: string }> }>(async (request, context) => {
  const { journalId } = await context.params;
  const details = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getJournalDetails(tx, journalId),
  );
  return json(details);
});
