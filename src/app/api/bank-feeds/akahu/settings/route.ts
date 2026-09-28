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
 * Saves the organisation's Akahu personal app (`appToken`, `userToken`,
 * `syncEveryHours`; blank tokens keep the saved ones). The tokens are checked
 * with Akahu first, outside any database transaction.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const typed = parseAkahuSettingsInput(body);
  const credentials = await withOrganisation(request, body.organisationId, "admin", (tx) => resolveAkahuTokens(tx, typed));
  let accountCount: number;
  try {
    accountCount = (await listAkahuAccounts(credentials)).length;
  } catch (error) {
    throw akahuProblem(error);
  }
  const akahu = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveAkahuSettings(tx, credentials, typed.syncEveryHours),
  );
  return json({ akahu, accountCount });
});

/** Removes the organisation's Akahu tokens. Linked accounts can't sync until new ones are saved. */
export const DELETE = route(async (request) => {
  const akahu = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeAkahuSettings(tx));
  return json({ akahu });
});
