import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";

/**
 * The modules chosen when an organisation is created (#181, MOD2-MOD4):
 * Accounting, Tax (registered for GST, from #180), CRM and Analytics. Left
 * out, a module takes its usual default (Accounting and GST registration on,
 * CRM and Analytics off).
 */
export type InitialModules = { accounting: boolean; gstRegistered: boolean; crm: boolean; analytics: boolean };

export function parseInitialModules(input: unknown): InitialModules | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("modules must be an object.");
  const record = input as Record<string, unknown>;
  const flag = (name: keyof InitialModules, fallback: boolean) => {
    const value = record[name];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new ValidationError(`modules.${name} must be true or false.`);
    return value;
  };
  const modules = { accounting: flag("accounting", true), gstRegistered: flag("gstRegistered", true), crm: flag("crm", false), analytics: flag("analytics", false) };
  if (!modules.accounting && !modules.crm && !modules.analytics) throw new ValidationError("Keep at least one of Accounting, CRM or Analytics on.");
  return modules;
}

/** Sets a new organisation's modules once its database is ready, as its first owner. */
export async function applyInitialModules(organisation: OrganisationRecord, modules: InitialModules, actor: { userId: string; email: string }): Promise<void> {
  await withOrganisationTransaction(organisation, actor, (tx) =>
    updateOrganisationSettings(tx, {
      // CRM and Analytics first, so Accounting can go off in the same change (MOD5).
      crmEnabled: modules.crm,
      analyticsEnabled: modules.analytics,
      accountingEnabled: modules.accounting,
      // A new organisation has no GST number yet, so registration is the switch alone (NR8).
      ...(modules.gstRegistered ? {} : { gstRegistered: false }),
    }),
  );
}
