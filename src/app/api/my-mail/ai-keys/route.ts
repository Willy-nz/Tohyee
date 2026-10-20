import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { myMailAiKeys, setMailAiKey } from "@/lib/private-mail/ai";

/** GET ?organisationId=: the Owner's own working AI keys, and which can read their mail (PM15). */
export const GET = route(async (request) => {
  const keys = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx, { auth }) => myMailAiKeys(tx, await MailOwner.of(tx), auth));
  return json({ keys });
});

/** PUT: gives one of the Owner's own Look only keys the private-mail scope, or takes it away (PM15, PM16). Body: { organisationId, tokenId, canReadMail }. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const keys = await withOrganisation(request, body.organisationId, "sales_rep", async (tx, { auth }) => setMailAiKey(tx, await MailOwner.of(tx), auth, body.tokenId, body.canReadMail));
  return json({ keys });
});
