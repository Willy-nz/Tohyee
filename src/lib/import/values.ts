import { ACCOUNT_TYPES, type AccountType, isAccountType } from "@/lib/accounts/types";
import { parseBankAmount, parseBankDate, RowError } from "@/lib/bank/formats/common";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { ITEM_TYPES, type ItemType } from "@/lib/items/pricing";
import { dec, parseDecimalInput, roundHalfUp, toFixedString } from "@/lib/money/decimal";

/**
 * Reading the text in an imported cell (IM1-IM16). Each throws a
 * ValidationError that names the field, which the import shows against the row.
 */

function simple(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

export function yesNo(text: string, field: string): boolean {
  const value = simple(text);
  if (["yes", "y", "true", "1", "x"].includes(value)) return true;
  if (["no", "n", "false", "0"].includes(value)) return false;
  throw new ValidationError(`${field} should be yes or no, not "${text}".`);
}

/** An amount of money: 1,234.56, $46.00, (46.00) and -46.00 all work; at most 2 decimal places. */
export function money(text: string, field: string): string | null {
  // Excel keeps numbers as binary fractions, so 1725.1 can come out of an .xlsx as 1725.0999999999999.
  const trimmed = text.trim();
  if (/^-?\d+\.\d{9,}$/.test(trimmed)) return toFixedString(roundHalfUp(dec(trimmed), 2), 2);
  try {
    return parseBankAmount(text);
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(`${field}: ${error.message}`);
    throw error;
  }
}

/** A price or quantity: up to `maxScale` decimal places, "$" and thousands commas allowed. */
export function number(text: string, field: string, maxScale: number): string {
  const cleaned = text.replace(/^\s*(?:NZ\$|\$)/i, "").replace(/,/g, "").trim();
  if (/^-?\d+\.\d{9,}$/.test(cleaned)) return parseDecimalInput(toFixedString(roundHalfUp(dec(cleaned), maxScale), maxScale), field, { maxScale, allowZero: true });
  return parseDecimalInput(cleaned, field, { maxScale, allowZero: true });
}

export function date(text: string, field: string, order: "dmy" | "mdy" | "ymd" = "dmy"): string {
  const parsed = parseBankDate(text, order);
  if (!parsed) throw new ValidationError(`${field} "${text}" isn't a date Tohyee can read (use 31/03/2026 or 2026-03-31).`);
  return parsed;
}

/**
 * An account type from Tohyee's names ("Current asset", "current_asset") or
 * another system's ("Current Asset", "Overhead", "Sales", "Prepayment",
 * "Liability"…).
 */
const TYPE_NAMES: Record<string, AccountType> = {
  bank: "bank",
  "current asset": "current_asset",
  prepayment: "current_asset",
  inventory: "inventory",
  "fixed asset": "fixed_asset",
  "non current asset": "non_current_asset",
  "noncurrent asset": "non_current_asset",
  "current liability": "current_liability",
  liability: "current_liability",
  "credit card": "credit_card",
  "non current liability": "non_current_liability",
  "noncurrent liability": "non_current_liability",
  "term liability": "non_current_liability",
  equity: "equity",
  revenue: "revenue",
  sales: "revenue",
  income: "revenue",
  "other income": "other_income",
  "direct costs": "direct_costs",
  "cost of sales": "direct_costs",
  expense: "expense",
  expenses: "expense",
  overhead: "expense",
  overheads: "expense",
  "wages expense": "expense",
  "superannuation expense": "expense",
  depreciation: "depreciation",
};

export function accountType(text: string): AccountType {
  const raw = text.trim();
  if (isAccountType(raw)) return raw;
  const key = simple(raw);
  const byLabel = (Object.keys(ACCOUNT_TYPES) as AccountType[]).find((type) => simple(ACCOUNT_TYPES[type].label) === key);
  const found = byLabel ?? TYPE_NAMES[key];
  if (!found) {
    throw new ValidationError(
      `Type "${text}" isn't one Tohyee knows. Use one of: ${Object.values(ACCOUNT_TYPES)
        .map((type) => type.label)
        .join(", ")}.`,
    );
  }
  return found;
}

export function itemType(text: string): ItemType {
  const key = simple(text).replace(/ /g, "_");
  if ((ITEM_TYPES as readonly string[]).includes(key)) return key as ItemType;
  if (["non_stock", "nonstock", "product", "goods", "untracked"].includes(key)) return "non_stock";
  if (["stock", "tracked", "inventory", "stock_tracked", "tracked_inventory"].includes(key)) return "stock";
  if (["service", "services"].includes(key)) return "service";
  if (["kit", "kit_bundle", "bundle"].includes(key)) return "kit";
  throw new ValidationError(`Type "${text}" should be Service, Non-stock or Stock.`);
}

type TaxCodeRow = { code: string; label: string; category: string; rate: string; is_active: boolean };

/**
 * Finds tax codes from what a file calls them: Tohyee's code or label
 * ("GST", "Zero rated"), or another system's names ("15% GST on Income",
 * "GST on Expenses", "Zero Rated", "No GST", "Exempt Expenses"), matched to
 * the organisation's first active code of that kind.
 */
export class TaxCodeFinder {
  private constructor(private readonly codes: TaxCodeRow[]) {}

  static async load(tx: OrgTx): Promise<TaxCodeFinder> {
    const result = await tx.query<TaxCodeRow>("select code, label, category, rate::text, is_active from tax_codes order by code");
    return new TaxCodeFinder(result.rows);
  }

  find(text: string, field: string): string | null {
    const raw = text.trim();
    if (!raw) return null;
    const exact = this.codes.find((row) => row.code === raw.toUpperCase() || simple(row.label) === simple(raw));
    if (exact) return exact.code;
    const key = simple(raw);
    let category: string | null = null;
    if (/import/.test(key)) {
      throw new ValidationError(`${field} "${text}": GST on imports isn't supported yet, so choose another code.`);
    } else if (/zero/.test(key)) category = "zero_rated";
    else if (/exempt/.test(key)) category = "exempt";
    else if (/^(no gst|no tax|none|gst free|tax exempt|out of scope|bas excluded)/.test(key)) category = "out_of_scope";
    else if (/gst|15%|standard/.test(key)) category = "standard";
    const match = category ? this.codes.find((row) => row.category === category && row.is_active) : undefined;
    if (!match) throw new ValidationError(`${field} "${text}" doesn't match any of this organisation's tax codes.`);
    return match.code;
  }
}
