import { randomBytes } from "node:crypto";
import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { akahuAuthorizeUrl } from "@/lib/bank/akahu/client";
import { akahuServerConfig } from "@/lib/bank/akahu/settings";
import { ValidationError } from "@/lib/errors";

/**
 * GET: where to send an organisation admin to connect the organisation's banks
 * through Akahu's consent screen (full Akahu apps only). The state names the
 * organisation and is stored once, for the callback to check.
 */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const config = await akahuServerConfig();
  if (config.mode !== "oauth" || !config.redirectUri) {
    throw new ValidationError("This server uses a personal Akahu app, so there's nothing to connect: a server admin links accounts directly.");
  }
  const url = await withOrganisation(request, organisationId, "admin", async (tx, { auth, membership }) => {
    const state = `${membership.organisation.id}.${randomBytes(24).toString("hex")}`;
    await tx.query("insert into akahu_oauth_states (state, user_id) values ($1, $2)", [state, auth.user.id]);
    return akahuAuthorizeUrl(config.appToken, config.redirectUri!, state);
  });
  return json({ url });
});
