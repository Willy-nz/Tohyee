import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getWiseLink, linkWiseBalance, unlinkWiseBalance } from "@/lib/bank/wise/service";

type Context = { params: Promise<{ accountId: string }> };

/** The account's Wise link and its last sync, or null. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const link = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getWiseLink(tx, accountId));
  return json({ link });
});

/** Links a Wise balance currency (`currency`, `startDate`). Admins. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const link = await withOrganisation(request, body.organisationId, "admin", (tx) => linkWiseBalance(tx, accountId, body));
  return json({ link }, { status: 201 });
});

/** Unlinks the account. Lines already brought in stay. Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => unlinkWiseBalance(tx, accountId));
  return json({ link: null });
});
