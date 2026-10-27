import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { signOut } from "@/lib/safety/inductions";

type Context = { params: Promise<{ recordId: string }> };

/** Signs out now, or fixes a missed sign-out (`leftAt` and `why`). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const visit = await withFarmWork(request, body.organisationId, "read", (tx) => signOut(tx, recordId, body));
  return json({ visit });
});
