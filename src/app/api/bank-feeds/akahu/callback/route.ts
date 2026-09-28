import { NextResponse } from "next/server";
import { authenticate, requireOrganisationRole } from "@/lib/auth/guard";
import { exchangeAkahuCode } from "@/lib/bank/akahu/client";
import { akahuServerConfig } from "@/lib/bank/akahu/settings";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { encryptSecret } from "@/lib/secrets";

function back(request: Request, query: string) {
  return NextResponse.redirect(new URL(`/operations/bank-accounts?${query}`, request.url), { status: 303 });
}

/**
 * Akahu sends the admin back here after the consent screen. The state must be
 * one this server issued in the last 15 minutes, to the same signed-in user,
 * and unused. The code is exchanged for a user token outside any database
 * transaction, then stored encrypted.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const organisationId = state.split(".")[0];
  if (url.searchParams.get("error")) return back(request, `akahu=cancelled`);
  try {
    const auth = await authenticate(request);
    const membership = await requireOrganisationRole(auth, organisationId, "admin");
    const actor = { userId: auth.user.id, email: auth.user.email };
    const valid = await withOrganisationTransaction(membership.organisation, actor, async (tx) => {
      const used = await tx.query(
        `update akahu_oauth_states set used_at = now()
          where state = $1 and user_id = $2 and used_at is null and created_at > now() - interval '15 minutes'`,
        [state, auth.user.id],
      );
      return (used.rowCount ?? 0) === 1;
    });
    if (!valid || !code) return back(request, "akahu=expired");
    const config = await akahuServerConfig();
    const token = await exchangeAkahuCode(config.appToken, config.appSecret ?? "", code, config.redirectUri ?? "");
    await withOrganisationTransaction(membership.organisation, actor, async (tx) => {
      await tx.query("update akahu_connections set status = 'revoked', revoked_at = now() where status = 'active'");
      await tx.query(
        "insert into akahu_connections (token_ciphertext, scope, connected_by_email) values ($1, $2, $3)",
        [encryptSecret(token.accessToken), token.scope, auth.user.email],
      );
    });
    return back(request, `akahu=connected&organisationId=${encodeURIComponent(organisationId)}`);
  } catch (error) {
    console.warn("[tohyee] Akahu connection failed:", error instanceof Error ? error.message : error);
    return back(request, "akahu=failed");
  }
}
