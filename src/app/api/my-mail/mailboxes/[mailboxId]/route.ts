import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { disconnectMyMailbox, myMail, setCopying } from "@/lib/private-mail/store";

type Context = { params: Promise<{ mailboxId: string }> };

/** PATCH: the private copy switch (PM1, PM12). Body: { organisationId, copying }. The Owner's own mailbox only. */
export const PATCH = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) => {
    const owner = await MailOwner.of(tx);
    await setCopying(tx, owner, mailboxId, body.copying);
    return myMail(tx, owner);
  });
  return json(result);
});

/** DELETE ?organisationId=: disconnects the mailbox (tokens, folder choice, the farm calendar's items); the copy stays until deleted (PM12). */
export const DELETE = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => {
    const owner = await MailOwner.of(tx);
    await disconnectMyMailbox(tx, owner, mailboxId);
    return myMail(tx, owner);
  });
  return json(result);
});
