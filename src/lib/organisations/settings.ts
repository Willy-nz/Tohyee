import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { isFinancialYearEndMonth } from "@/lib/financial-year";
import { parseCurrencyCode } from "@/lib/money/currency";
import { GST_BASES, type GstBasis } from "@/lib/tax/categories";
import { requireOneOf, requireString } from "@/lib/validation";

export type OrganisationSettings = {
  organisationId: string;
  displayName: string;
  baseCurrency: string;
  /** The financial year ends on the last day of this month (1-12). */
  financialYearEndMonth: number;
  /** For the GST return; nothing else uses it. */
  gstBasis: GstBasis;
  /** The Advanced reporting module: tracking categories, custom fields and salespeople (TC1-TC10, CF1-CF10, SR1-SR8). */
  advancedFeatures: boolean;
  /** The CRM module (MOD1, CRM1-CRM9). */
  crmEnabled: boolean;
  hasPostings: boolean;
};

export async function getOrganisationSettings(tx: OrgTx): Promise<OrganisationSettings> {
  const result = await tx.query<{
    organisation_id: string;
    display_name: string;
    base_currency: string;
    financial_year_end_month: number;
    gst_basis: GstBasis;
    advanced_features: boolean;
    crm_enabled: boolean;
    has_postings: boolean;
  }>(
    `select organisation_id, display_name, base_currency, financial_year_end_month, gst_basis, advanced_features, crm_enabled,
            exists (select 1 from ledger_journals) as has_postings
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  return {
    organisationId: row.organisation_id,
    displayName: row.display_name,
    baseCurrency: row.base_currency,
    financialYearEndMonth: row.financial_year_end_month,
    gstBasis: row.gst_basis,
    advancedFeatures: row.advanced_features,
    crmEnabled: row.crm_enabled,
    hasPostings: row.has_postings,
  };
}

function parseFinancialYearEndMonth(input: unknown): number {
  const value = typeof input === "string" && /^\d{1,2}$/.test(input.trim()) ? Number(input.trim()) : input;
  if (!isFinancialYearEndMonth(value)) {
    throw new ValidationError("financialYearEndMonth must be a month number from 1 to 12.");
  }
  return value;
}

/**
 * Admins can rename the organisation and set its financial year end and GST
 * basis. The base currency can only change before anything has been posted;
 * after that every amount would change meaning. The year end only affects
 * reports, so it can change at any time.
 */
export async function updateOrganisationSettings(
  tx: OrgTx,
  input: { displayName?: unknown; baseCurrency?: unknown; financialYearEndMonth?: unknown; gstBasis?: unknown; advancedFeatures?: unknown; crmEnabled?: unknown },
): Promise<OrganisationSettings> {
  const current = await getOrganisationSettings(tx);
  const displayName =
    input.displayName === undefined
      ? current.displayName
      : requireString(input.displayName, "displayName", { maxLength: 150 });
  const baseCurrency =
    input.baseCurrency === undefined
      ? current.baseCurrency
      : parseCurrencyCode(input.baseCurrency, "baseCurrency");
  const financialYearEndMonth =
    input.financialYearEndMonth === undefined
      ? current.financialYearEndMonth
      : parseFinancialYearEndMonth(input.financialYearEndMonth);
  const gstBasis =
    input.gstBasis === undefined ? current.gstBasis : requireOneOf(input.gstBasis, "gstBasis", GST_BASES);
  if (input.advancedFeatures !== undefined && typeof input.advancedFeatures !== "boolean") {
    throw new ValidationError("advancedFeatures must be true or false.");
  }
  const advancedFeatures = input.advancedFeatures === undefined ? current.advancedFeatures : input.advancedFeatures;
  if (input.crmEnabled !== undefined && typeof input.crmEnabled !== "boolean") {
    throw new ValidationError("crmEnabled must be true or false.");
  }
  const crmEnabled = input.crmEnabled === undefined ? current.crmEnabled : input.crmEnabled;

  if (baseCurrency !== current.baseCurrency && current.hasPostings) {
    throw new ValidationError(
      "The base currency can't change once journals have been posted.",
    );
  }

  await tx.query(
    `update organisation_settings
        set display_name = $1, base_currency = $2, financial_year_end_month = $3, gst_basis = $4,
            advanced_features = $5, crm_enabled = $6, updated_at = now()
      where id = true`,
    [displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled],
  );
  await writeAuditEvent(tx, {
    eventType: "organisation.settings_updated",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled },
  });
  return { ...current, displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled };
}

/**
 * Copies the name and base currency into the core registry (used for listings).
 * Called after the organisation transaction has committed.
 */
export async function syncOrganisationRegistry(settings: OrganisationSettings): Promise<void> {
  await coreQuery(
    `update organisations set display_name = $2, base_currency = $3, updated_at = now() where id = $1`,
    [settings.organisationId, settings.displayName, settings.baseCurrency],
  );
}
