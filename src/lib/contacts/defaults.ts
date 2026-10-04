import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { checkNewTags, loadTrackingContext, parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import { optionalString } from "@/lib/validation";

/**
 * A contact's default accounts and tracking (SD1-SD3), like Xero's contact
 * "Purchase defaults" and "Sales defaults" and NetSuite's vendor default
 * expense account. New purchase lines (bills, supplier credit notes, spend
 * money) start with the purchase defaults, new sales lines (invoices, sales
 * credit notes, receive money) with the sales ones, and bulk coding uses them
 * for a line with no account. They're only a starting point.
 */
export type ContactDefaults = {
  defaultPurchaseAccountCode: string | null;
  defaultSalesAccountCode: string | null;
  defaultPurchaseTracking: TrackingTags;
  defaultSalesTracking: TrackingTags;
};

export type ContactDefaultsInput = {
  defaultPurchaseAccountCode?: unknown;
  defaultSalesAccountCode?: unknown;
  defaultPurchaseTracking?: unknown;
  defaultSalesTracking?: unknown;
};

export const NO_CONTACT_DEFAULTS: ContactDefaults = {
  defaultPurchaseAccountCode: null,
  defaultSalesAccountCode: null,
  defaultPurchaseTracking: {},
  defaultSalesTracking: {},
};

/** Columns to select from `contacts` for the defaults. */
export const CONTACT_DEFAULT_COLUMNS = `
  (select a.code from accounts a where a.id = contacts.default_purchase_account_id) as default_purchase_account_code,
  (select a.code from accounts a where a.id = contacts.default_sales_account_id) as default_sales_account_code,
  contacts.default_purchase_tracking, contacts.default_sales_tracking`;

export type ContactDefaultRow = {
  default_purchase_account_code: string | null;
  default_sales_account_code: string | null;
  default_purchase_tracking: TrackingTags | null;
  default_sales_tracking: TrackingTags | null;
};

export function contactDefaultsFromRow(row: ContactDefaultRow): ContactDefaults {
  return {
    defaultPurchaseAccountCode: row.default_purchase_account_code ?? null,
    defaultSalesAccountCode: row.default_sales_account_code ?? null,
    defaultPurchaseTracking: sortedTags(row.default_purchase_tracking ?? {}),
    defaultSalesTracking: sortedTags(row.default_sales_tracking ?? {}),
  };
}

type AccountRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  account_class: AccountClass;
  account_type: AccountType;
  system_key: string | null;
  currency_code: string | null;
};

async function resolveAccount(
  tx: OrgTx,
  input: unknown,
  kept: string | null,
  side: "purchase" | "sales",
): Promise<{ id: string; code: string } | null | undefined> {
  if (input === undefined) return undefined;
  const field = side === "purchase" ? "defaultPurchaseAccountCode" : "defaultSalesAccountCode";
  const code = optionalString(input, field, { maxLength: 20 });
  if (code === null) return null;
  const found = await tx.query<AccountRow>(
    "select id, code, name, is_active, account_class, account_type, system_key, currency_code from accounts where lower(code) = lower($1)",
    [code],
  );
  const account = found.rows[0];
  if (!account) throw new ValidationError(`There's no account with the code ${code}.`);
  // One archived after it was set is kept, but a new choice must be active (SD3).
  if (!account.is_active && account.code !== kept) {
    throw new ValidationError(`Account ${account.code} (${account.name}) is archived, so it can't be a contact's default ${side} account.`);
  }
  if (side === "purchase") {
    const problem = billLineAccountProblem({
      accountClass: account.account_class,
      accountType: account.account_type,
      systemKey: account.system_key,
      currencyCode: account.currency_code === tx.baseCurrency ? null : account.currency_code,
    });
    if (problem) throw new ValidationError(`The default purchase account can't be account ${account.code} (${account.name}): it's ${problem}`);
  } else if (account.account_class !== "revenue") {
    throw new ValidationError(
      `The default sales account can't be account ${account.code} (${account.name}): it isn't a revenue account. Invoice lines go to revenue accounts, like Sales.`,
    );
  }
  return { id: account.id, code: account.code };
}

async function resolveTracking(tx: OrgTx, input: unknown, kept: TrackingTags, label: string): Promise<TrackingTags | undefined> {
  if (input === undefined) return undefined;
  const tags = sortedTags(parseTrackingInput(input, label));
  // Values it already had can stay though archived since (SD3); new ones must be active.
  checkNewTags(await loadTrackingContext(tx), tags, label, new Set(Object.values(kept)));
  return tags;
}

const sameTags = (left: TrackingTags, right: TrackingTags) => JSON.stringify(sortedTags(left)) === JSON.stringify(sortedTags(right));

/**
 * Works out the defaults as sent (anything not sent stays as it was) and
 * saves them on the contact. Returns the changes for its history.
 */
export async function saveContactDefaults(
  tx: OrgTx,
  contactId: string,
  input: ContactDefaultsInput,
  current: ContactDefaults,
): Promise<Record<string, { from: unknown; to: unknown }>> {
  const purchase = await resolveAccount(tx, input.defaultPurchaseAccountCode, current.defaultPurchaseAccountCode, "purchase");
  const sales = await resolveAccount(tx, input.defaultSalesAccountCode, current.defaultSalesAccountCode, "sales");
  const purchaseTracking = await resolveTracking(tx, input.defaultPurchaseTracking, current.defaultPurchaseTracking, "Default purchase");
  const salesTracking = await resolveTracking(tx, input.defaultSalesTracking, current.defaultSalesTracking, "Default sales");

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (purchase !== undefined && (purchase?.code ?? null) !== current.defaultPurchaseAccountCode) {
    changes.defaultPurchaseAccountCode = { from: current.defaultPurchaseAccountCode, to: purchase?.code ?? null };
  }
  if (sales !== undefined && (sales?.code ?? null) !== current.defaultSalesAccountCode) {
    changes.defaultSalesAccountCode = { from: current.defaultSalesAccountCode, to: sales?.code ?? null };
  }
  if (purchaseTracking !== undefined && !sameTags(purchaseTracking, current.defaultPurchaseTracking)) {
    changes.defaultPurchaseTracking = { from: current.defaultPurchaseTracking, to: purchaseTracking };
  }
  if (salesTracking !== undefined && !sameTags(salesTracking, current.defaultSalesTracking)) {
    changes.defaultSalesTracking = { from: current.defaultSalesTracking, to: salesTracking };
  }
  if (Object.keys(changes).length === 0) return changes;

  await tx.query(
    `update contacts
        set default_purchase_account_id = case when $2::boolean then $3::bigint else default_purchase_account_id end,
            default_sales_account_id = case when $4::boolean then $5::bigint else default_sales_account_id end,
            default_purchase_tracking = coalesce($6::jsonb, default_purchase_tracking),
            default_sales_tracking = coalesce($7::jsonb, default_sales_tracking)
      where id = $1`,
    [
      contactId,
      purchase !== undefined,
      purchase?.id ?? null,
      sales !== undefined,
      sales?.id ?? null,
      purchaseTracking === undefined ? null : JSON.stringify(purchaseTracking),
      salesTracking === undefined ? null : JSON.stringify(salesTracking),
    ],
  );
  return changes;
}

/**
 * A contact's defaults for one side, as a new line or bulk coding uses them
 * (SD1-SD3): the account only when it's still active, and tracking values
 * only when they're still active. Null account means there's no default.
 */
export async function usableContactDefaults(
  tx: OrgTx,
  contactId: string,
  side: "purchase" | "sales",
): Promise<{ accountCode: string | null; taxCode: string | null; tracking: TrackingTags }> {
  const found = await tx.query<{ account_code: string | null; tax_code: string | null; tracking: TrackingTags | null }>(
    side === "purchase"
      ? `select (select a.code from accounts a where a.id = c.default_purchase_account_id and a.is_active) as account_code,
                (select t.code from tax_codes t where t.id = c.default_purchase_tax_code_id and t.is_active) as tax_code,
                c.default_purchase_tracking as tracking
           from contacts c where c.id = $1`
      : `select (select a.code from accounts a where a.id = c.default_sales_account_id and a.is_active) as account_code,
                (select t.code from tax_codes t where t.id = c.default_sales_tax_code_id and t.is_active) as tax_code,
                c.default_sales_tracking as tracking
           from contacts c where c.id = $1`,
    [contactId],
  );
  const row = found.rows[0];
  if (!row) return { accountCode: null, taxCode: null, tracking: {} };
  const ctx = await loadTrackingContext(tx);
  const tracking: TrackingTags = {};
  for (const [categoryId, valueId] of Object.entries(row.tracking ?? {})) {
    const value = ctx.values.get(valueId);
    const category = ctx.categories.get(categoryId);
    if (ctx.advancedFeatures && value?.isActive && category?.isActive && value.categoryId === categoryId) tracking[categoryId] = valueId;
  }
  return { accountCode: row.account_code, taxCode: row.tax_code, tracking: sortedTags(tracking) };
}
