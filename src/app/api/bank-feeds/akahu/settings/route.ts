import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { akahuProblem, listAkahuAccounts } from "@/lib/bank/akahu/client";
import {
  getAkahuSettings,
  parseAkahuSettingsInput,
  removeAkahuSettings,
  resolveAkahuTokens,
  saveAkahuSettings,
} from "@/lib/bank/akahu/settings";

/** GET: whether this organisation's Akahu personal app is set up (tokens are never returned). */
export const GET = route(async (request) => {
  const akahu = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAkahuSettings(tx));
  return json({ akahu });
});

/**
 * Saves an Akahu personal app (`appToken`, `userToken`, `syncEveryHours`;
 * blank tokens keep the saved ones): new tokens for the login
 * `connectionId` (or the only one), or with `add: true` a new login called
 * `name` (#182, BK30). The tokens are checked with Akahu first, outside any
 * database transaction; a login's linked accounts the new tokens can't see
 * stop (BK34).
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const typed = parseAkahuSettingsInput(body);
  const adding = body.add === true;
  const credentials = await withOrganisation(request, body.organisationId, "admin", (tx) => resolveAkahuTokens(tx, typed, { adding }));
  let visible: string[];
  try {
    visible = (await listAkahuAccounts(credentials)).map((account) => account._id);
  } catch (error) {
    throw akahuProblem(error);
  }
  const akahu = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveAkahuSettings(tx, credentials, typed.syncEveryHours, { adding, connectionId: typed.connectionId, name: body.name, visibleAccountIds: visible }),
  );
  return json({ akahu, accountCount: visible.length });
});

/** Removes an Akahu login (`connectionId`, or the only one): its accounts' feeds stop, their lines stay (BK35). */
export const DELETE = route(async (request) => {
  const params = searchParams(request);
  const akahu = await withOrganisation(request, params.get("organisationId"), "admin", (tx) => removeAkahuSettings(tx, params.get("connectionId")));
  return json({ akahu });
});
