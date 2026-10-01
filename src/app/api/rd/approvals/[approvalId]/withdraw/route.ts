import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { withdrawApproval } from "@/lib/rd/register";

type Context = { params: Promise<{ approvalId: string }> };

/** POST: withdraws an approval entered by mistake, with a reason (admins and above). It's kept, marked withdrawn. */
export const POST = route<Context>(async (request, context) => {
  const { approvalId } = await context.params;
  const body = await readJson(request);
  const approval = await withOrganisation(request, body.organisationId, "admin", (tx) => withdrawApproval(tx, approvalId, body.reason));
  return json({ approval });
});
