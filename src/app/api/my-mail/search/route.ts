import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { searchMyMail } from "@/lib/private-mail/store";

/**
 * POST: the Owner's own email, newest first, or what matches a search
 * (PM9). Body: { organisationId, query?, copyId?, before? }. A POST so the
 * search words never sit in an address, where proxies and logs keep them.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) =>
    searchMyMail(tx, await MailOwner.of(tx), { query: body.query, copyId: body.copyId, before: body.before }),
  );
  return json(result);
});
