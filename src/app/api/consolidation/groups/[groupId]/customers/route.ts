import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { createGroupCustomer, listGroupCustomers } from "@/lib/consolidation/customers";

type Context = { params: Promise<{ groupId: string }> };

/** GET: the group's customers, each a person's link between contacts in member organisations (decision 642). */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json(await listGroupCustomers({ id: auth.user.id, email: auth.user.email }, groupId));
});

/** POST `{ name, links: [{ organisationId, contactId }] }`: links one customer's contacts in two or more members. Bookkeepers of every organisation. */
export const POST = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json(await createGroupCustomer({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)), { status: 201 });
});
