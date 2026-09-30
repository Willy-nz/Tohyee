import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { isFinancialYearEndMonth } from "@/lib/financial-year";
import { assertFinancialYearEndChangeable } from "@/lib/ledger/period-controls";
import { parseCurrencyCode } from "@/lib/money/currency";
import { GST_BASES, type GstBasis } from "@/lib/tax/categories";
import { optionalString, requireOneOf, requireString } from "@/lib/validation";

/** A GST number as digits (8 or 9), the same check as contacts'. */
function parseGstNumber(input: unknown): string | null {
  const value = optionalString(input, "GST number", { maxLength: 20 });
  if (value === null) return null;
  const digits = value.replace(/[ -]/g, "");
  if (!/^[0-9 -]+$/.test(value) || !/^[0-9]{8,9}$/.test(digits)) {
    throw new ValidationError("GST number must have 8 or 9 digits, like 123-456-789.");
  }
  return digits;
}

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
  /** Whether stock may go below zero (ST9-ST12); off by default. */
  allowNegativeStock: boolean;
  /** Shown on printed invoices, credit notes and quotes (PD1). */
  postalAddress: string | null;
  /** The organisation's GST number, as digits (PD1); shown on tax invoices. */
  gstNumber: string | null;
  /** How customers pay, e.g. the bank account number (PD1); shown on printed invoices. */
  paymentDetails: string | null;
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
    allow_negative_stock: boolean;
    postal_address: string | null;
    gst_number: string | null;
    payment_details: string | null;
    has_postings: boolean;
  }>(
    `select organisation_id, display_name, base_currency, financial_year_end_month, gst_basis, advanced_features, crm_enabled, allow_negative_stock,
            postal_address, gst_number, payment_details,
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
    allowNegativeStock: row.allow_negative_stock,
    postalAddress: row.postal_address,
    gstNumber: row.gst_number,
    paymentDetails: row.payment_details,
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
  input: {
    displayName?: unknown;
    baseCurrency?: unknown;
    financialYearEndMonth?: unknown;
    gstBasis?: unknown;
    advancedFeatures?: unknown;
    crmEnabled?: unknown;
    allowNegativeStock?: unknown;
    postalAddress?: unknown;
    gstNumber?: unknown;
    paymentDetails?: unknown;
  },
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
  if (input.allowNegativeStock !== undefined && typeof input.allowNegativeStock !== "boolean") {
    throw new ValidationError("allowNegativeStock must be true or false.");
  }
  const allowNegativeStock = input.allowNegativeStock === undefined ? current.allowNegativeStock : input.allowNegativeStock;
  if (current.allowNegativeStock && !allowNegativeStock) {
    // ST12. The database refuses it too.
    const below = await tx.query<{ item_code: string }>(
      "select item_code from inventory_item_balances where on_hand_quantity < 0 or carrying_value < 0 order by item_code limit 3",
    );
    if (below.rows.length > 0) {
      throw new ValidationError(
        `Some stock is below zero (${below.rows.map((row) => row.item_code).join(", ")}), so negative stock can't be turned off. Receive or adjust it back to zero or more first.`,
      );
    }
  }

  const postalAddress =
    input.postalAddress === undefined ? current.postalAddress : optionalString(input.postalAddress, "postalAddress", { maxLength: 500 });
  const gstNumber = input.gstNumber === undefined ? current.gstNumber : parseGstNumber(input.gstNumber);
  const paymentDetails =
    input.paymentDetails === undefined ? current.paymentDetails : optionalString(input.paymentDetails, "paymentDetails", { maxLength: 1000 });

  if (financialYearEndMonth !== current.financialYearEndMonth) {
    await assertFinancialYearEndChangeable(tx, current.financialYearEndMonth);
  }
  if (baseCurrency !== current.baseCurrency && current.hasPostings) {
    throw new ValidationError(
      "The base currency can't change once journals have been posted.",
    );
  }

  await tx.query(
    `update organisation_settings
        set display_name = $1, base_currency = $2, financial_year_end_month = $3, gst_basis = $4,
            advanced_features = $5, crm_enabled = $6, allow_negative_stock = $7, postal_address = $8, gst_number = $9,
            payment_details = $10, updated_at = now()
      where id = true`,
    [displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled, allowNegativeStock, postalAddress, gstNumber, paymentDetails],
  );
  await writeAuditEvent(tx, {
    eventType: "organisation.settings_updated",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled, allowNegativeStock, postalAddress, gstNumber, paymentDetails },
  });
  return { ...current, displayName, baseCurrency, financialYearEndMonth, gstBasis, advancedFeatures, crmEnabled, allowNegativeStock, postalAddress, gstNumber, paymentDetails };
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
