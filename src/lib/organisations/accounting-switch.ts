import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";

/** Whether the Accounting module is on for this organisation (#181, MOD2-MOD7); on unless switched off. */
export async function accountingEnabled(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ accounting_enabled: boolean }>("select accounting_enabled from organisation_settings where id = true");
  return result.rows[0]?.accounting_enabled !== false;
}

/** Refuses something that posts to or reads the books while Accounting is off (MOD3). */
export async function requireAccounting(tx: OrgTx): Promise<void> {
  if (!(await accountingEnabled(tx))) throw new ConflictError("Accounting is off for this organisation. An admin can turn it on under Modules.");
}

/**
 * SQL that's true while Accounting is on, for background jobs' "what's due"
 * queries: bank feeds, sales platform syncs, repeating documents and the rest
 * pause while it's off and carry on from where they stopped (MOD6).
 */
export const ACCOUNTING_ON_SQL = "coalesce((select accounting_enabled from organisation_settings where id = true), true)";
