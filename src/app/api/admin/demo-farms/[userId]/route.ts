import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { addDemoFarm, deleteDemoFarm, findDemoPerson } from "@/lib/demo/service";

/*
 * One login's demo farm (#445): POST resets it (deleted and made again from
 * the start, in the background), DELETE removes it for good. Server admins,
 * on the server computer only. The page asks first.
 */

type Context = { params: Promise<{ userId: string }> };

export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  const actor = { id: auth.user.id, email: auth.user.email };
  const person = await findDemoPerson(actor, { userId });
  const demo = await addDemoFarm(person, { actor, reset: true });
  return json({ demoFarm: { ...demo, userId: person.id, email: person.email } }, { status: 202 });
});

export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  const actor = { id: auth.user.id, email: auth.user.email };
  const person = await findDemoPerson(actor, { userId });
  await deleteDemoFarm(person, { actor });
  return json({ deleted: true });
});
