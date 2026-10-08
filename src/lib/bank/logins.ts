import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Several logins per bank feed provider (#182, BK30-BK37, decision 481):
 * Akahu, SimpleFIN, Stripe, PayPal and Wise each keep a list of named
 * logins instead of one connection.
 */
export type FeedProvider = "akahu" | "simplefin" | "stripe" | "paypal" | "wise";

export const PROVIDER_LABELS: Record<FeedProvider, string> = {
  akahu: "Akahu",
  simplefin: "SimpleFIN",
  stripe: "Stripe",
  paypal: "PayPal",
  wise: "Wise",
};

/** A connection id as sent: undefined or null when not sent. */
export function optionalConnectionId(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const text = String(input);
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ValidationError("connectionId must be a login's id.");
  return text;
}

/**
 * Which login a command is for: the one named by `connectionId`, or the only
 * one when there's just one (so single-login organisations work as before).
 * Null when there are none; refused when there are several and none was
 * chosen.
 */
export function pickLogin<T extends { id: string }>(rows: readonly T[], connectionIdInput: unknown, provider: FeedProvider): T | null {
  const connectionId = optionalConnectionId(connectionIdInput);
  if (connectionId !== null) {
    const found = rows.find((row) => row.id === connectionId);
    if (!found) throw new NotFoundError(`That ${PROVIDER_LABELS[provider]} login isn't connected.`);
    return found;
  }
  if (rows.length <= 1) return rows[0] ?? null;
  throw new ValidationError(`There are ${rows.length} ${PROVIDER_LABELS[provider]} logins. Choose which one.`);
}

/**
 * A new login's name (BK30): required, at most 100 characters, and not the
 * same as another active login's (ignoring case). Left blank for the first
 * login, it's the provider's name (as existing logins became, BK37).
 */
export async function newLoginName(tx: OrgTx, provider: FeedProvider, input: unknown): Promise<string> {
  const typed = typeof input === "string" ? input.trim() : input == null ? "" : null;
  if (typed === null) throw new ValidationError("The login's name must be text.");
  const existing = await tx.query<{ name: string }>(`select name from ${provider}_connections where status = 'active'`);
  const name = typed || (existing.rows.length === 0 ? PROVIDER_LABELS[provider] : "");
  if (!name) throw new ValidationError(`Name this ${PROVIDER_LABELS[provider]} login, e.g. "Will's BNZ login".`);
  if (name.length > 100) throw new ValidationError("A login's name can be at most 100 characters.");
  if (existing.rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    throw new ConflictError(`${PROVIDER_LABELS[provider]} already has a login called ${name}.`);
  }
  return name;
}
