import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput } from "@/lib/money/decimal";
import { TAX_CATEGORIES, type TaxCategory } from "@/lib/tax/categories";
import {
  optionalSource,
  requireIdempotencyKey,
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
  };
}

const COLUMNS = "id, request_hash, code, label, category, rate, is_active, effective_from, effective_to";

export async function listTaxCodes(tx: OrgTx): Promise<TaxCode[]> {
  const result = await tx.query<TaxCodeRow>(`select ${COLUMNS} from tax_codes order by code`);
  return result.rows.map(toTaxCode);
}

/**
 * Tax codes are settings (e.g. GST 15%). Sales invoice lines use them to work
 * out GST, which is posted when the invoice is approved. Manual journal lines
 * don't carry tax codes, and the GST return isn't built yet.
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

  const hash = requestHash("tax_code", { code, label, category, rate, effectiveFrom, effectiveTo });
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
                            rate, effective_from, effective_to)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9)
     on conflict do nothing
     returning ${COLUMNS}`,
    [source, idempotencyKey, hash, code, label, category, rate, effectiveFrom, effectiveTo],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new ConflictError(`A tax code called ${code} already exists.`);
  }
  await writeAuditEvent(tx, {
    eventType: "tax.code_created",
    entityType: "tax_code",
    entityId: row.id,
    details: { code, category, rate, effectiveFrom, effectiveTo },
  });
  return { created: true, taxCode: toTaxCode(row) };
}
