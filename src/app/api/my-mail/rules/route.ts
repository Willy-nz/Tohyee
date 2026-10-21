import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { createRule } from "@/lib/private-mail/filing";

/**
 * POST: a filing rule the Owner approves once (PM26): { organisationId,
 * copyId, sender?, fileName?, destination, includeExisting? }. Matches wait
 * in "To file" until the Owner confirms each one; nothing is filed by it.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const rules = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) =>
    createRule(tx, await MailOwner.of(tx), { copyId: body.copyId, sender: body.sender, fileName: body.fileName, destination: body.destination, includeExisting: body.includeExisting }),
  );
  return json({ rules }, { status: 201 });
});
