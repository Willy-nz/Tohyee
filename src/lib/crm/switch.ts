import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";

/** Whether the CRM module is on for this organisation (example MOD1). */
export async function crmEnabled(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ crm_enabled: boolean }>("select crm_enabled from organisation_settings where id = true");
  return result.rows[0]?.crm_enabled === true;
}

/** Refuses CRM commands while the module is off (MOD1). */
export async function requireCrm(tx: OrgTx): Promise<void> {
  if (!(await crmEnabled(tx))) throw new ConflictError("The CRM is off. An admin can turn it on in Settings.");
}
