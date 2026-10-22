import { writeAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import type { AiTokenIdentity } from "@/lib/ai/tokens";
import { aiKeyVia, listAiTokens } from "@/lib/ai/tokens";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { MailOwner, notFound } from "@/lib/private-mail/access";

/*
 * The private-mail scope for an Owner's own AI key (#250 part 2; PM15-PM19,
 * decisions 618, 619). Only the copy's Owner can give it, only to their own
 * keys in this organisation, and only to Look only keys, so an AI reading
 * the mail can't write anything into Tohyee's shared records. The MCP
 * server offers the mail tools only to a key that has it, and the access
 * layer checks it again on every call.
 */

/** A key (startsWith "tohyee_ai_…") or an AI app connected by signing in (startsWith null, decision 823). */
export type MailAiKey = { id: string; name: string; startsWith: string | null; lookOnly: boolean; canReadMail: boolean };

/** Whether this key has the private-mail scope, given by `userId`. */
export async function aiKeyHasMailScope(tx: OrgTx, userId: string, tokenId: string): Promise<boolean> {
  const found = await tx.query("select 1 from private_mail_ai_keys where token_id = $1 and owner_user_id = $2", [tokenId, userId]);
  return Boolean(found.rowCount);
}

/** PM15: the Owner's own working AI keys here, and which can read their mail. */
export async function myMailAiKeys(tx: OrgTx, owner: MailOwner, auth: AuthContext): Promise<MailAiKey[]> {
  owner.check(tx);
  if (auth.user.id !== owner.userId) throw notFound();
  const keys = (await listAiTokens(auth, tx.organisationId)).filter((key) => !key.revokedAt && !key.expired);
  const granted = new Set((await tx.query<{ token_id: string }>("select token_id from private_mail_ai_keys where owner_user_id = $1", [owner.userId])).rows.map((row) => row.token_id));
  return keys.map((key) => ({ id: key.id, name: key.name, startsWith: key.startsWith, lookOnly: key.accessLevel === "read", canReadMail: granted.has(key.id) && key.accessLevel === "read" }));
}

/** PM15, PM16: gives or takes the scope. Only the Owner's own working Look only keys; anyone else's is "not found". */
export async function setMailAiKey(tx: OrgTx, owner: MailOwner, auth: AuthContext, tokenInput: unknown, on: unknown): Promise<MailAiKey[]> {
  const keys = await myMailAiKeys(tx, owner, auth);
  const key = keys.find((entry) => entry.id === String(tokenInput ?? ""));
  if (!key) throw notFound();
  if (typeof on !== "boolean") throw new ValidationError("Say whether this key can read your mail.");
  if (on && !key.lookOnly) throw new ValidationError("Only a Look only AI key can read your mail, so it can't copy anything from it into Tohyee. Make a Look only key for it.");
  if (on) await tx.query("insert into private_mail_ai_keys (token_id, owner_user_id) values ($1, $2) on conflict (token_id) do nothing", [key.id, owner.userId]);
  else await tx.query("delete from private_mail_ai_keys where token_id = $1 and owner_user_id = $2", [key.id, owner.userId]);
  // The key's id only: never the mail (decision 617).
  await writeAuditEvent(tx, { eventType: on ? "private_mail.ai_key_allowed" : "private_mail.ai_key_stopped", entityType: "ai_access_token", entityId: key.id, details: {} });
  return myMailAiKeys(tx, owner, auth);
}

/** PM17: the MailOwner for an AI key's call, or "not found" unless its Owner gave it the scope and it's Look only. */
export async function mailOwnerForKey(tx: OrgTx, identity: Pick<AiTokenIdentity, "tokenId" | "accessLevel">): Promise<MailOwner> {
  if (identity.accessLevel !== "read") throw notFound();
  return MailOwner.of(tx, { aiTokenId: identity.tokenId, granted: aiKeyHasMailScope });
}

/** Whether the MCP server should offer the mail tools to this key at all (checked again on each call). */
export async function keyCanReadMail(identity: AiTokenIdentity): Promise<boolean> {
  if (identity.membership.role !== "owner" || identity.accessLevel !== "read") return false;
  try {
    return await withOrganisationTransaction(
      identity.membership.organisation,
      { userId: identity.user.id, email: identity.user.email, via: aiKeyVia(identity) },
      async (tx) => {
        await mailOwnerForKey(tx, identity);
        return true;
      },
      { readOnly: true },
    );
  } catch {
    return false;
  }
}
