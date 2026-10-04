import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getSimpleFinLink, linkSimpleFinAccount, unlinkSimpleFinAccount } from "@/lib/bank/simplefin/service";

type Context = { params: Promise<{ accountId: string }> };

/** The account's SimpleFIN link and its last sync, or null. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const link = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getSimpleFinLink(tx, accountId));
  return json({ link });
});

/** Links a SimpleFIN account (`simplefinAccountId`, `startDate`, `timeZone`). Admins. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const link = await withOrganisation(request, body.organisationId, "admin", (tx) => linkSimpleFinAccount(tx, accountId, body));
  return json({ link }, { status: 201 });
});

/** Unlinks the account. Lines already brought in stay. Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => unlinkSimpleFinAccount(tx, accountId));
  return json({ link: null });
});
