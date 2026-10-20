import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { MailOwner } from "@/lib/private-mail/access";
import { myMail, startMyMailConnect } from "@/lib/private-mail/store";

/*
 * My mail (#250, decision 611): an Owner's private copy of their own mail.
 * Every route lets in any member at the role gate, then the access layer
 * answers "not found" to anyone who isn't the signed-in Owner whose copy it
 * is, so no one can tell whether there's anything there.
 */

/** GET ?organisationId=: the signed-in Owner's own mailboxes and copies (PM1, PM3). */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => myMail(tx, await MailOwner.of(tx)));
  return json(result);
});

/** POST: starts connecting a mailbox for a private copy. Body: { organisationId, provider, historyDays? }. Returns the sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  const result = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) =>
    startMyMailConnect(tx, await MailOwner.of(tx), { provider: body.provider, historyDays: body.historyDays }, origin),
  );
  return json(result);
});
