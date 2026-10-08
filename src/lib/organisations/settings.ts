import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { isFinancialYearEndMonth } from "@/lib/financial-year";
import { assertFinancialYearEndChangeable } from "@/lib/ledger/period-controls";
import { parseCurrencyCode } from "@/lib/money/currency";
import { type GstPeriodSetting, gstPeriodSetting } from "@/lib/reports/gst-boxes";
import { type AvailableOn, isAvailableOn, onlyWords } from "@/lib/tax/available-on";
import { GST_BASES, type GstBasis } from "@/lib/tax/categories";
import { parseIsoDate } from "@/lib/dates";
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
  /**
   * How often GST is filed and which months periods end in (GP1-GP6), or
   * null when not set. Used by the GST return, Home and the period close.
   */
  gstPeriod: GstPeriodSetting | null;
  /** The Advanced reporting module: tracking categories, custom fields and salespeople (TC1-TC10, CF1-CF10, SR1-SR8). */
  advancedFeatures: boolean;
  /** The Accounting module (#181, MOD2-MOD7); on unless the organisation only uses the CRM or Analytics. */
  accountingEnabled: boolean;
  /** The CRM module (MOD1, CRM1-CRM9). */
  crmEnabled: boolean;
  /** The Analytics module (decision 353). */
  analyticsEnabled: boolean;
  /** The Not-for-profit module (NFP1). */
  notForProfitEnabled: boolean;
  /** Whether stock may go below zero (ST9-ST12); off by default. */
  allowNegativeStock: boolean;
  /** NetSuite's "Foreign Trade" (EX3, EX4): overseas customers' new sales lines start with the tax code for exports. Off by default. */
  foreignTrade: boolean;
  /** NetSuite's "Tax Code for Exports" (EX4, EX13): a zero-rated sales tax code, ZERO to start with. */
  exportTaxCode: string | null;
  /** Shown on printed invoices, credit notes and quotes (PD1). */
  postalAddress: string | null;
  /** The organisation's GST number, as digits (PD1); shown on tax invoices. */
  gstNumber: string | null;
  /** Registered for GST (issue #180, NR1-NR8); new organisations start registered. */
  gstRegistered: boolean;
  /** Registered from this date (NR5); null = from the start. */
  gstRegisteredFrom: string | null;
  /** Registration ended on this date (NR6), or null while still registered. */
  gstRegisteredUntil: string | null;
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
    gst_period_months: number | null;
    gst_period_end_month: number | null;
    advanced_features: boolean;
    accounting_enabled: boolean;
    crm_enabled: boolean;
    analytics_enabled: boolean;
    not_for_profit_enabled: boolean;
    allow_negative_stock: boolean;
    foreign_trade: boolean;
    export_tax_code: string | null;
    postal_address: string | null;
    gst_number: string | null;
    gst_registered: boolean;
    gst_registered_from: string | null;
    gst_registered_until: string | null;
    payment_details: string | null;
    has_postings: boolean;
  }>(
    `select organisation_id, display_name, base_currency, financial_year_end_month, gst_basis, gst_period_months, gst_period_end_month, advanced_features, accounting_enabled, crm_enabled, analytics_enabled, not_for_profit_enabled, allow_negative_stock,
            foreign_trade, (select t.code from tax_codes t where t.id = export_tax_code_id) as export_tax_code,
            postal_address, gst_number, gst_registered, gst_registered_from::text, gst_registered_until::text, payment_details,
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
    gstPeriod:
      row.gst_period_months === null || row.gst_period_end_month === null
        ? null
        : gstPeriodSetting(row.gst_period_months, row.gst_period_end_month),
    advancedFeatures: row.advanced_features,
    accountingEnabled: row.accounting_enabled,
    crmEnabled: row.crm_enabled,
    analyticsEnabled: row.analytics_enabled,
    notForProfitEnabled: row.not_for_profit_enabled,
    allowNegativeStock: row.allow_negative_stock,
    foreignTrade: row.foreign_trade,
    exportTaxCode: row.export_tax_code,
    postalAddress: row.postal_address,
    gstNumber: row.gst_number,
    gstRegistered: row.gst_registered,
    gstRegisteredFrom: row.gst_registered_from,
    gstRegisteredUntil: row.gst_registered_until,
    paymentDetails: row.payment_details,
    hasPostings: row.has_postings,
  };
}

/**
 * The GST period setting (GP1): `months` blank clears it; otherwise 1, 2 or 6
 * with any month a period ends in (defaults to the financial year end
 * month, as IRD aligns periods with the balance date).
 */
function parseGstPeriod(monthsInput: unknown, endMonthInput: unknown, financialYearEndMonth: number): GstPeriodSetting | null {
  if (monthsInput === null || monthsInput === "") return null;
  const whole = (value: unknown) => (typeof value === "string" && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : value);
  const months = whole(monthsInput);
  const endMonth = endMonthInput === undefined || endMonthInput === null || endMonthInput === "" ? financialYearEndMonth : whole(endMonthInput);
  if (typeof months !== "number" || typeof endMonth !== "number") {
    throw new ValidationError("The GST filing frequency is monthly (1), two-monthly (2) or six-monthly (6), with a month a period ends in (1-12).");
  }
  return gstPeriodSetting(months, endMonth);
}

const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  standard: "standard-rated",
  exempt: "exempt",
  out_of_scope: "no GST (out of scope)",
};

/**
 * The tax code for exports (EX13): an active zero-rated code available on
 * sales (TAO7). Exports are zero-rated, not exempt (IR375), so they count in
 * Box 5 and Box 6; an exempt or standard-rated code is refused. The database
 * checks it too.
 */
async function resolveExportTaxCode(tx: OrgTx, input: unknown): Promise<{ id: string; code: string }> {
  const code = requireString(input, "exportTaxCode", { maxLength: 20 }).toUpperCase();
  const found = await tx.query<{ id: string; code: string; category: string; is_active: boolean; available_on: AvailableOn }>(
    "select id, code, category, is_active, available_on from tax_codes where code = $1",
    [code],
  );
  const row = found.rows[0];
  if (!row) throw new ValidationError(`There's no tax code ${code}.`);
  if (!row.is_active) throw new ValidationError(`${row.code} is inactive, so it can't be the tax code for exports. Choose an active zero-rated code.`);
  if (row.category !== "zero_rated") {
    throw new ValidationError(
      `The tax code for exports must be zero-rated (like ZERO): exports are zero-rated, not exempt, so they count in Box 5 and Box 6 of the GST return. ${row.code} is ${CATEGORY_WORDS[row.category] ?? row.category}.`,
    );
  }
  if (!isAvailableOn(row.available_on, "sales")) {
    throw new ValidationError(
      `${row.code} is available on ${onlyWords(row.available_on)}, so it can't be the tax code for exports. Choose a zero-rated code available on sales.`,
    );
  }
  return { id: row.id, code: row.code };
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
    gstPeriodMonths?: unknown;
    gstPeriodEndMonth?: unknown;
    advancedFeatures?: unknown;
    accountingEnabled?: unknown;
    crmEnabled?: unknown;
    analyticsEnabled?: unknown;
    notForProfitEnabled?: unknown;
    allowNegativeStock?: unknown;
    foreignTrade?: unknown;
    exportTaxCode?: unknown;
    postalAddress?: unknown;
    gstNumber?: unknown;
    gstRegistered?: unknown;
    gstRegisteredFrom?: unknown;
    gstRegisteredUntil?: unknown;
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
  const gstPeriod =
    input.gstPeriodMonths === undefined && input.gstPeriodEndMonth === undefined
      ? current.gstPeriod
      : parseGstPeriod(
          input.gstPeriodMonths === undefined ? (current.gstPeriod?.months ?? null) : input.gstPeriodMonths,
          input.gstPeriodEndMonth === undefined ? current.gstPeriod?.endMonth : input.gstPeriodEndMonth,
          financialYearEndMonth,
        );
  if (input.advancedFeatures !== undefined && typeof input.advancedFeatures !== "boolean") {
    throw new ValidationError("advancedFeatures must be true or false.");
  }
  let advancedFeatures = input.advancedFeatures === undefined ? current.advancedFeatures : input.advancedFeatures;
  if (input.crmEnabled !== undefined && typeof input.crmEnabled !== "boolean") {
    throw new ValidationError("crmEnabled must be true or false.");
  }
  const crmEnabled = input.crmEnabled === undefined ? current.crmEnabled : input.crmEnabled;
  if (input.analyticsEnabled !== undefined && typeof input.analyticsEnabled !== "boolean") {
    throw new ValidationError("analyticsEnabled must be true or false.");
  }
  const analyticsEnabled = input.analyticsEnabled === undefined ? current.analyticsEnabled : input.analyticsEnabled;
  if (input.notForProfitEnabled !== undefined && typeof input.notForProfitEnabled !== "boolean") {
    throw new ValidationError("notForProfitEnabled must be true or false.");
  }
  let notForProfitEnabled = input.notForProfitEnabled === undefined ? current.notForProfitEnabled : input.notForProfitEnabled;
  if (input.accountingEnabled !== undefined && typeof input.accountingEnabled !== "boolean") {
    throw new ValidationError("accountingEnabled must be true or false.");
  }
  const accountingEnabled = input.accountingEnabled === undefined ? current.accountingEnabled : input.accountingEnabled;
  // MOD5: one app stays on; Advanced reporting and Not-for-profit need Accounting.
  if (!accountingEnabled && !crmEnabled && !analyticsEnabled) {
    throw new ValidationError("Keep at least one of Accounting, CRM or Analytics on.");
  }
  if (!accountingEnabled) {
    if (input.advancedFeatures === true || input.notForProfitEnabled === true) {
      throw new ValidationError("Advanced reporting and Not-for-profit need Accounting. Turn Accounting on first.");
    }
    // Turning Accounting off turns them off too (the screen asks first, listing them).
    advancedFeatures = false;
    notForProfitEnabled = false;
  }
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

  if (input.foreignTrade !== undefined && typeof input.foreignTrade !== "boolean") {
    throw new ValidationError("foreignTrade must be true or false.");
  }
  const foreignTrade = input.foreignTrade === undefined ? current.foreignTrade : input.foreignTrade;
  const exportTax =
    input.exportTaxCode === undefined || input.exportTaxCode === current.exportTaxCode
      ? null
      : await resolveExportTaxCode(tx, input.exportTaxCode);
  const exportTaxCode = exportTax ? exportTax.code : current.exportTaxCode;

  const postalAddress =
    input.postalAddress === undefined ? current.postalAddress : optionalString(input.postalAddress, "postalAddress", { maxLength: 500 });
  const gstNumber = input.gstNumber === undefined ? current.gstNumber : parseGstNumber(input.gstNumber);
  const paymentDetails =
    input.paymentDetails === undefined ? current.paymentDetails : optionalString(input.paymentDetails, "paymentDetails", { maxLength: 1000 });
  const optionalDate = (value: unknown, field: string) => (value === null || value === "" ? null : parseIsoDate(value, field));
  if (input.gstRegistered !== undefined && typeof input.gstRegistered !== "boolean") {
    throw new ValidationError("gstRegistered must be true or false.");
  }
  const gstRegistered = input.gstRegistered === undefined ? current.gstRegistered : input.gstRegistered;
  const gstRegisteredFrom = !gstRegistered
    ? null
    : input.gstRegisteredFrom === undefined
      ? current.gstRegisteredFrom
      : optionalDate(input.gstRegisteredFrom, "The date GST registration starts");
  const gstRegisteredUntil = !gstRegistered
    ? null
    : input.gstRegisteredUntil === undefined
      ? current.gstRegisteredUntil
      : optionalDate(input.gstRegisteredUntil, "The date GST registration ended");
  await checkGstRegistration(tx, current, { gstNumber, gstRegistered, gstRegisteredFrom, gstRegisteredUntil });

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
            advanced_features = $5, crm_enabled = $6, not_for_profit_enabled = $7, allow_negative_stock = $8,
            postal_address = $9, gst_number = $10, payment_details = $11, gst_period_months = $12,
            gst_period_end_month = $13, foreign_trade = $14,
            export_tax_code_id = coalesce($15::bigint, export_tax_code_id), analytics_enabled = $16,
            gst_registered = $19, gst_registered_from = $17::date, gst_registered_until = $18::date, accounting_enabled = $20, updated_at = now()
      where id = true`,
    [
      displayName,
      baseCurrency,
      financialYearEndMonth,
      gstBasis,
      advancedFeatures,
      crmEnabled,
      notForProfitEnabled,
      allowNegativeStock,
      postalAddress,
      gstNumber,
      paymentDetails,
      gstPeriod?.months ?? null,
      gstPeriod?.endMonth ?? null,
      foreignTrade,
      exportTax?.id ?? null,
      analyticsEnabled,
      gstRegisteredFrom,
      gstRegisteredUntil,
      gstRegistered,
      accountingEnabled,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "organisation.settings_updated",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: {
      displayName,
      baseCurrency,
      financialYearEndMonth,
      gstBasis,
      gstPeriod,
      advancedFeatures,
      crmEnabled,
      notForProfitEnabled,
      allowNegativeStock,
      postalAddress,
      gstNumber,
      paymentDetails,
      // Only when they change, so earlier history reads the same (EX4).
      ...(foreignTrade !== current.foreignTrade ? { foreignTrade } : {}),
      ...(exportTaxCode !== current.exportTaxCode ? { exportTaxCode } : {}),
      ...(analyticsEnabled !== current.analyticsEnabled ? { analyticsEnabled } : {}),
      ...(accountingEnabled !== current.accountingEnabled ? { accountingEnabled } : {}),
      ...(gstRegistered !== current.gstRegistered ? { gstRegistered } : {}),
      ...(gstRegisteredFrom !== current.gstRegisteredFrom ? { gstRegisteredFrom } : {}),
      ...(gstRegisteredUntil !== current.gstRegisteredUntil ? { gstRegisteredUntil } : {}),
    },
  });
  return {
    ...current,
    displayName,
    baseCurrency,
    financialYearEndMonth,
    gstBasis,
    gstPeriod,
    advancedFeatures,
    accountingEnabled,
    crmEnabled,
    analyticsEnabled,
    notForProfitEnabled,
    allowNegativeStock,
    foreignTrade,
    exportTaxCode,
    postalAddress,
    gstNumber,
    gstRegistered,
    gstRegisteredFrom,
    gstRegisteredUntil,
    paymentDetails,
  };
}

/**
 * GST registration (issue #180, NR5-NR8): turning it on needs a GST number;
 * the end can't be before the start; and the change can't leave GST already
 * in the books (on the GST account) outside the registration, since approved
 * documents never change (NR7).
 */
async function checkGstRegistration(
  tx: OrgTx,
  current: OrganisationSettings,
  next: { gstNumber: string | null; gstRegistered: boolean; gstRegisteredFrom: string | null; gstRegisteredUntil: string | null },
): Promise<void> {
  if (next.gstRegistered && !current.gstRegistered && next.gstNumber === null) {
    throw new ValidationError("Enter the GST number to register for GST.");
  }
  if (next.gstRegisteredUntil !== null && next.gstRegisteredFrom !== null && next.gstRegisteredUntil < next.gstRegisteredFrom) {
    throw new ValidationError(`GST registration can't end (${next.gstRegisteredUntil}) before it starts (${next.gstRegisteredFrom}).`);
  }
  if (
    next.gstRegistered === current.gstRegistered &&
    next.gstRegisteredFrom === current.gstRegisteredFrom &&
    next.gstRegisteredUntil === current.gstRegisteredUntil
  ) {
    return;
  }
  const outside = await tx.query<{ first: string | null; last: string | null }>(
    `select min(j.posting_date)::text as first, max(j.posting_date)::text as last
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       join accounts a on a.id = l.account_id
      where a.system_key = 'gst'
        and (not $1::boolean
             or ($2::date is not null and j.posting_date < $2::date)
             or ($3::date is not null and j.posting_date > $3::date))`,
    [next.gstRegistered, next.gstRegisteredFrom, next.gstRegisteredUntil],
  );
  const row = outside.rows[0];
  if (row?.first) {
    const span = `${row.first}${row.last !== row.first ? ` to ${row.last}` : ""}`;
    throw new ValidationError(
      !next.gstRegistered
        ? `GST has already been charged or claimed in the books (${span}), so this organisation can't be made not registered. Set the date its registration ended instead.`
        : `GST has been charged or claimed in the books on dates outside these registration dates (${span}). Approved documents don't change, so choose dates that cover them.`,
    );
  }
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
