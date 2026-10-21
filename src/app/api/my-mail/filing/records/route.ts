import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { searchFilingRecords } from "@/lib/private-mail/filing";

/** POST: records to attach a filed attachment to (PM23). Body: { organisationId, type, query? }. The Owner of a private copy only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const records = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) => searchFilingRecords(tx, await MailOwner.of(tx), { type: body.type, query: body.query }));
  return json({ records });
});
