import { json, requireAuth, route, searchParams } from "@/lib/api/http";
import { searchMemberContacts } from "@/lib/consolidation/customers";

type Context = { params: Promise<{ groupId: string }> };

/** GET `?organisationId&q`: a member's contacts to choose from when linking a group customer. Nothing is matched automatically. */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  const params = searchParams(request);
  return json({ contacts: await searchMemberContacts({ id: auth.user.id, email: auth.user.email }, groupId, { organisationId: params.get("organisationId"), q: params.get("q") }) });
});
