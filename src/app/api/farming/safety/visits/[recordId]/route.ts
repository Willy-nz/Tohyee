import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { signOut } from "@/lib/safety/inductions";

type Context = { params: Promise<{ recordId: string }> };

/** Signs out now, or fixes a missed sign-out (`leftAt` and `why`). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const visit = await withOrganisation(request, body.organisationId, "viewer", (tx) => signOut(tx, recordId, body));
  return json({ visit });
});
