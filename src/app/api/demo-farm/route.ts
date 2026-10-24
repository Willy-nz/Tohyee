import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { addDemoFarm, deleteDemoFarm, getDemoFarm } from "@/lib/demo/service";
import { demoFarmEnabled } from "@/lib/demo/switch";

/*
 * The signed-in person's demo farm (#437): GET how it is (and whether the
 * server offers it), POST to add it or reset it (made in the background;
 * GET again to follow along), DELETE to remove it. Anyone signed in may
 * have one, for themselves only.
 */

export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  return json({ enabled: demoFarmEnabled(), demo: await getDemoFarm(auth.user.id) });
});

export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const demo = await addDemoFarm({ id: auth.user.id, email: auth.user.email }, { reset: body.action === "reset" });
  return json({ enabled: true, demo }, { status: 202 });
});

export const DELETE = route(async (request) => {
  const auth = await requireAuth(request);
  await deleteDemoFarm({ id: auth.user.id, email: auth.user.email });
  return json({ enabled: demoFarmEnabled(), demo: null });
});
