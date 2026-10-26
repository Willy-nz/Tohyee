import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { addDemoFarm, findDemoPerson, listDemoFarms } from "@/lib/demo/service";
import { demoFarmEnabled } from "@/lib/demo/switch";

/*
 * The demo farms on this server (#445, decisions 880-884), added where
 * organisations are added: the server settings, for server admins on the
 * server computer only. Each belongs to one login (one each) and shows in
 * that person's organisation list once it's made.
 */

/** GET: whether the server offers it, and every demo farm with its progress and whose it is. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ enabled: demoFarmEnabled(), demoFarms: await listDemoFarms() });
});

/**
 * POST { ownerEmail? }: starts making the demo farm for that login, or for
 * the signed-in server admin when it's blank. Returns at once (202); GET
 * again to follow the build.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const actor = { id: auth.user.id, email: auth.user.email };
  const person = await findDemoPerson(actor, { email: body.ownerEmail });
  const demo = await addDemoFarm(person, { actor });
  return json({ demoFarm: { ...demo, userId: person.id, email: person.email } }, { status: 202 });
});
