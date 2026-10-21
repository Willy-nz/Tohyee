import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { dismissToFile } from "@/lib/private-mail/filing";

type Context = { params: Promise<{ entryId: string }> };

/** DELETE ?organisationId=: takes an attachment off "To file" without filing it (PM27). */
export const DELETE = route<Context>(async (request, context) => {
  const { entryId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => dismissToFile(tx, await MailOwner.of(tx), entryId));
  return json({ dismissed: true });
});
