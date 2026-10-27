import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { turnOffSiteLink } from "@/lib/safety/inductions";

type Context = { params: Promise<{ linkId: string }> };

/** Turns a sign-in link off (for good). */
export const POST = route<Context>(async (request, context) => {
  const { linkId } = await context.params;
  const body = await readJson(request);
  const links = await withFarmWork(request, body.organisationId, "read", (tx) => turnOffSiteLink(tx, linkId));
  return json({ links });
});
