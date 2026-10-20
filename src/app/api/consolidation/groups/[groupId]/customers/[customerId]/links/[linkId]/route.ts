import { json, requireAuth, route } from "@/lib/api/http";
import { removeGroupCustomerLink } from "@/lib/consolidation/customers";

type Context = { params: Promise<{ groupId: string; customerId: string; linkId: string }> };

/** DELETE: unlinks a contact from a group customer (kept, with who unlinked it). Bookkeepers of every organisation. */
export const DELETE = route<Context>(async (request, context) => {
  const { groupId, customerId, linkId } = await context.params;
  const auth = await requireAuth(request);
  return json(await removeGroupCustomerLink({ id: auth.user.id, email: auth.user.email }, groupId, customerId, linkId));
});
