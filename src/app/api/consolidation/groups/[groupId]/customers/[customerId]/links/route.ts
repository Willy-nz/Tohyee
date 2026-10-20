import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { addGroupCustomerLink } from "@/lib/consolidation/customers";

type Context = { params: Promise<{ groupId: string; customerId: string }> };

/** POST `{ organisationId, contactId }`: links one more contact to a group customer. Bookkeepers of every organisation. */
export const POST = route<Context>(async (request, context) => {
  const { groupId, customerId } = await context.params;
  const auth = await requireAuth(request);
  return json(await addGroupCustomerLink({ id: auth.user.id, email: auth.user.email }, groupId, customerId, await readJson(request)));
});
