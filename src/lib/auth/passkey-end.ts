import type { DbClient } from "@/lib/db/transactions";

/**
 * Ends every passkey a login has, inside the caller's transaction: a
 * password or two-step reset, a setup link, a login turned off (decision
 * 892). Their sessions go with them. The caller disconnects apps
 * (revokeUserAiKeys). Returns how many there were.
 */
export async function endPasskeys(client: DbClient, userId: string): Promise<number> {
  const removed = await client.query("delete from user_passkeys where user_id = $1", [userId]);
  return removed.rowCount ?? 0;
}
