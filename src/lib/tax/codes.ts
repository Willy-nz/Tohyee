import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput } from "@/lib/money/decimal";
import { AVAILABLE_ON, AVAILABLE_ON_LABELS, type AvailableOn, isAvailableOn, type TaxSide } from "@/lib/tax/available-on";
import { TAX_CATEGORIES, type TaxCategory } from "@/lib/tax/categories";
import {
  optionalSource,
  requireIdempotencyKey,
  requireId,
  requireOneOf,
  requireString,
} from "@/lib/validation";

export { TAX_CATEGORIES, type TaxCategory };

export type TaxCode = {
  id: string;
  code: string;
  label: string;
  category: TaxCategory;
  rate: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** NetSuite's "Available on" (TAO1-TAO12): sales, purchases or both. */
  availableOn: AvailableOn;
};

type TaxCodeRow = {
  id: string;
  request_hash: string;
  code: string;
  label: string;
  category: TaxCategory;
  rate: string;
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
  available_on: AvailableOn;
};

function toTaxCode(row: TaxCodeRow): TaxCode {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    category: row.category,
    rate: row.rate,
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    availableOn: row.available_on,
  };
}

const COLUMNS = "id, request_hash, code, label, category, rate, is_active, effective_from, effective_to, available_on";

export async function listTaxCodes(tx: OrgTx): Promise<TaxCode[]> {
  const result = await tx.query<TaxCodeRow>(`select ${COLUMNS} from tax_codes order by code`);
  return result.rows.map(toTaxCode);
}

/**
 * Tax codes are settings (e.g. GST 15%). Sales invoice lines use them to work
 * out GST, which is posted when the invoice is approved. Manual journal lines
 * don't carry tax codes. The GST return puts document lines into boxes by
 * their tax code's category.
 */
export async function createTaxCode(
  tx: OrgTx,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    code: unknown;
    label: unknown;
    category: unknown;
    rate: unknown;
    effectiveFrom: unknown;
    effectiveTo?: unknown;
    /** Sales, purchases or both (the default), TAO5. */
    availableOn?: unknown;
  },
): Promise<{ created: boolean; taxCode: TaxCode }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const code = requireString(input.code, "code", {
    maxLength: 20,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/,
    patternHint: "code must be 1-20 letters, numbers, dashes or underscores.",
  }).toUpperCase();
  const label = requireString(input.label, "label", { maxLength: 100 });
  const category = requireOneOf(input.category, "category", TAX_CATEGORIES);
  const rate = parseDecimalInput(input.rate, "rate", { maxScale: 6, allowZero: true });
  if (cmp(dec(rate), dec("1")) > 0) {
    throw new ValidationError("rate is a fraction: 0.15 means 15%.");
  }
  if (category !== "standard" && cmp(dec(rate), dec("0")) !== 0) {
    throw new ValidationError(`A ${category.replace("_", " ")} tax code must have a rate of 0.`);
  }
  const effectiveFrom = parseIsoDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalIsoDate(input.effectiveTo, "effectiveTo");
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new ValidationError("effectiveTo must be on or after effectiveFrom.");
  }

  const availableOn = input.availableOn == null || input.availableOn === "" ? "both" : requireOneOf(input.availableOn, "availableOn", AVAILABLE_ON);
  // Both is left out of the hash, so requests from before "Available on" still match.
  const hash = requestHash("tax_code", { code, label, category, rate, effectiveFrom, effectiveTo, ...(availableOn === "both" ? {} : { availableOn }) });
  const existing = await tx.query<TaxCodeRow>(
    `select ${COLUMNS} from tax_codes where command_source = $1 and idempotency_key = $2`,
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "tax code");
    return { created: false, taxCode: toTaxCode(existing.rows[0]) };
  }

  const inserted = await tx.query<TaxCodeRow>(
    `insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category,
                            rate, effective_from, effective_to, available_on)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)
     on conflict do nothing
     returning ${COLUMNS}`,
    [source, idempotencyKey, hash, code, label, category, rate, effectiveFrom, effectiveTo, availableOn],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new ConflictError(`A tax code called ${code} already exists.`);
  }
  await writeAuditEvent(tx, {
    eventType: "tax.code_created",
    entityType: "tax_code",
    entityId: row.id,
    details: { code, category, rate, effectiveFrom, effectiveTo, availableOn },
  });
  return { created: true, taxCode: toTaxCode(row) };
}

/**
 * What uses a code for one side (TAO10): contacts' defaults, the tax code for
 * exports, items' codes and bank rules. Accounts aren't here: an account's
 * usual code is only used on the sides the code is available on (TAO6).
 */
async function usesOnSide(tx: OrgTx, taxCodeId: string, side: TaxSide): Promise<string[]> {
  const word = side === "sales" ? "sales" : "purchase";
  const contactColumn = side === "sales" ? "default_sales_tax_code_id" : "default_purchase_tax_code_id";
  const itemColumn = side === "sales" ? "sales_tax_code_id" : "purchase_tax_code_id";
  const uses: string[] = [];
  const contacts = await tx.query<{ name: string }>(`select name from contacts where ${contactColumn} = $1 order by name`, [taxCodeId]);
  // "Kauri Supplies' default", "Cloud Apps Inc's default".
  uses.push(...contacts.rows.map((row) => `${row.name}${row.name.endsWith("s") ? "'" : "'s"} default ${word} tax code`));
  if (side === "sales") {
    const exports = await tx.query("select 1 from organisation_settings where export_tax_code_id = $1", [taxCodeId]);
    if (exports.rowCount) uses.push("the tax code for exports (Settings › Exports)");
  }
  const items = await tx.query<{ code: string }>(`select code from items where ${itemColumn} = $1 order by code`, [taxCodeId]);
  uses.push(...items.rows.map((row) => `item ${row.code}'s ${word} tax code`));
  const rules = await tx.query<{ name: string }>("select name from bank_rules where tax_code_id = $1 and direction = any($2::text[]) order by name", [
    taxCodeId,
    side === "sales" ? ["in", "any"] : ["out", "any"],
  ]);
  uses.push(...rules.rows.map((row) => `bank rule "${row.name}"`));
  return uses;
}

/**
 * Changes a tax code's "Available on" (TAO5, TAO10), admins only, audited as
 * tax.code_updated. Saved documents never change; a draft with the code on a
 * side it's no longer available on is refused when saved or approved
 * (TAO9). NetSuite lets defaults become unusable instead; Tohyee refuses the
 * change while a contact's default, the tax code for exports, an item or a
 * bank rule uses the code on the side it would lose, and lists them, so no
 * setting quietly stops working. The database refuses it too.
 */
export async function updateTaxCode(tx: OrgTx, idInput: unknown, input: { availableOn?: unknown }): Promise<TaxCode> {
  const id = requireId(idInput, "taxCodeId");
  const found = await tx.query<TaxCodeRow>(`select ${COLUMNS} from tax_codes where id = $1 for update`, [id]);
  const current = found.rows[0];
  if (!current) throw new NotFoundError("Tax code not found.");
  if (input.availableOn === undefined) return toTaxCode(current);
  const availableOn = requireOneOf(input.availableOn, "availableOn", AVAILABLE_ON);
  if (availableOn === current.available_on) return toTaxCode(current);
  const losing = (["sales", "purchases"] as const).filter((side) => !isAvailableOn(availableOn, side));
  for (const side of losing) {
    const uses = await usesOnSide(tx, current.id, side);
    if (uses.length > 0) {
      const shown = uses.slice(0, 10).join("; ") + (uses.length > 10 ? `; and ${uses.length - 10} more` : "");
      throw new ConflictError(
        `Tax code ${current.code} can't be made available on ${AVAILABLE_ON_LABELS[availableOn].toLowerCase()} only while it's used for ${side}: ${shown}. Change those first.`,
      );
    }
  }
  const updated = await tx.query<TaxCodeRow>(`update tax_codes set available_on = $2, updated_at = now() where id = $1 returning ${COLUMNS}`, [
    current.id,
    availableOn,
  ]);
  await writeAuditEvent(tx, {
    eventType: "tax.code_updated",
    entityType: "tax_code",
    entityId: current.id,
    details: { code: current.code, changes: { availableOn: { from: current.available_on, to: availableOn } } },
  });
  return toTaxCode(updated.rows[0]);
}
