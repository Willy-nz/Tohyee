import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { deleteMyCopy, myMail } from "@/lib/private-mail/store";

type Context = { params: Promise<{ copyId: string }> };

/** DELETE ?organisationId=: "Delete imported history": its emails, attachments and search tokens (PM13). The mailbox isn't touched. */
export const DELETE = route<Context>(async (request, context) => {
  const { copyId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => {
    const owner = await MailOwner.of(tx);
    await deleteMyCopy(tx, owner, copyId);
    return myMail(tx, owner);
  });
  return json(result);
});
