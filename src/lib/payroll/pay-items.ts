import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { NOT_SUPPORTED } from "@/lib/payroll/rates";
import { requireBoolean, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Pay items (example PRUN10): the earnings, after-tax deductions and
 * employer contributions a pay run is made of, each with its account and
 * its tax treatment per IRD's Payroll Calculations and Business Rules
 * Specification (5.7, 5.11 and 4.5.1). Every organisation starts with a set
 * (migration 0058); admins with payroll access add more. "Taxable" means
 * PAYE, the ACC earners' levy and the student loan deduction together.
 * Archived, never deleted.
 */

export const PAY_ITEM_CATEGORIES = ["earnings", "deduction", "employer_contribution"] as const;
export type PayItemCategory = (typeof PAY_ITEM_CATEGORIES)[number];

export const PAY_ITEM_KINDS = [
  "ordinary_time",
  "overtime",
  "allowance",
  "holiday_pay",
  "reimbursement",
  "after_tax_deduction",
  "kiwisaver_employer",
] as const;
export type PayItemKind = (typeof PAY_ITEM_KINDS)[number];

/** The kinds an admin can add; the others come with the organisation. */
export const ADDABLE_PAY_ITEM_KINDS = ["overtime", "allowance", "holiday_pay", "reimbursement", "after_tax_deduction"] as const;
type AddableKind = (typeof ADDABLE_PAY_ITEM_KINDS)[number];

/** Kinds that are refused rather than guessed (PRUN8), with what they are and when they come. */
const REFUSED_KINDS: Record<string, string> = {
  bonus: "bonuses and other extra pays (IRD's extra-pay rules, payroll stage P12)",
  extra_pay: "bonuses and other extra pays (IRD's extra-pay rules, payroll stage P12)",
  commission: "bonuses and other extra pays (IRD's extra-pay rules, payroll stage P12)",
  back_pay: "back pay",
  final_pay: "final pays",
  leave: "leave (Holidays Act, payroll stage P8; holiday pay is a typed amount for now)",
  annual_leave: "leave (Holidays Act, payroll stage P8; holiday pay is a typed amount for now)",
  sick_leave: "leave (Holidays Act, payroll stage P8; holiday pay is a typed amount for now)",
  public_holiday: "leave (Holidays Act, payroll stage P8; holiday pay is a typed amount for now)",
  child_support: "child support deductions",
  payroll_giving: "payroll giving",
  employer_contribution: "employer contributions other than KiwiSaver",
  superannuation: "employer contributions other than KiwiSaver",
};

export const PAY_ITEM_KIND_LABELS: Record<PayItemKind, string> = {
  ordinary_time: "Ordinary time",
  overtime: "Overtime",
  allowance: "Allowance",
  holiday_pay: "Holiday pay (typed amount)",
  reimbursement: "Reimbursement",
  after_tax_deduction: "After-tax deduction",
  kiwisaver_employer: "KiwiSaver employer contribution",
};

const CATEGORY_OF: Record<PayItemKind, PayItemCategory> = {
  ordinary_time: "earnings",
  overtime: "earnings",
  allowance: "earnings",
  holiday_pay: "earnings",
  reimbursement: "earnings",
  after_tax_deduction: "deduction",
  kiwisaver_employer: "employer_contribution",
};

export type PayItem = {
  id: string;
  name: string;
  category: PayItemCategory;
  kind: PayItemKind;
  accountCode: string | null;
  accountName: string | null;
  /** Overtime only: the hourly rate is multiplied by this. */
  rateMultiplier: string | null;
  subjectToPaye: boolean;
  subjectToAccLevy: boolean;
  subjectToStudentLoan: boolean;
  subjectToKiwiSaver: boolean;
  subjectToEsct: boolean;
  isSystem: boolean;
  isArchived: boolean;
};

export type PayItemRow = {
  id: string;
  name: string;
  category: PayItemCategory;
  kind: PayItemKind;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  rate_multiplier: string | null;
  subject_to_paye: boolean;
  subject_to_acc_levy: boolean;
  subject_to_student_loan: boolean;
  subject_to_kiwisaver: boolean;
  subject_to_esct: boolean;
  is_system: boolean;
  is_archived: boolean;
  request_hash: string;
};

export const PAY_ITEM_COLUMNS = `p.id, p.name, p.category, p.kind, p.account_id::text, a.code as account_code, a.name as account_name,
  p.rate_multiplier::text, p.subject_to_paye, p.subject_to_acc_levy, p.subject_to_student_loan, p.subject_to_kiwisaver,
  p.subject_to_esct, p.is_system, p.is_archived, p.request_hash`;

export const PAY_ITEM_FROM = "payroll_pay_items p left join accounts a on a.id = p.account_id";

export function toPayItem(row: PayItemRow): PayItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    kind: row.kind,
    accountCode: row.account_code,
    accountName: row.account_name,
    rateMultiplier: row.rate_multiplier === null ? null : toPlainString(dec(row.rate_multiplier)),
    subjectToPaye: row.subject_to_paye,
    subjectToAccLevy: row.subject_to_acc_levy,
    subjectToStudentLoan: row.subject_to_student_loan,
    subjectToKiwiSaver: row.subject_to_kiwisaver,
    subjectToEsct: row.subject_to_esct,
    isSystem: row.is_system,
    isArchived: row.is_archived,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findPayItem(tx: OrgTx, id: unknown, forUpdate = false): Promise<PayItemRow> {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new NotFoundError("That pay item wasn't found.");
  if (forUpdate) await tx.query("select 1 from payroll_pay_items where id = $1 for update", [id]);
  const result = await tx.query<PayItemRow>(`select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM} where p.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That pay item wasn't found.");
  return result.rows[0];
}

export async function listPayItems(tx: OrgTx, options: { includeArchived?: boolean } = {}): Promise<PayItem[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<PayItemRow>(
    `select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM}
      where ($1::boolean or not p.is_archived)
      order by array_position(array['earnings', 'deduction', 'employer_contribution'], p.category),
               array_position(array['ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement',
                                    'after_tax_deduction', 'kiwisaver_employer'], p.kind),
               lower(p.name), p.id`,
    [options.includeArchived ?? false],
  );
  return result.rows.map(toPayItem);
}

function parseKind(input: unknown): AddableKind {
  if (typeof input === "string" && REFUSED_KINDS[input]) {
    throw new ValidationError(`${NOT_SUPPORTED}: pay items for ${REFUSED_KINDS[input]}.`);
  }
  if (typeof input === "string" && (input === "ordinary_time" || input === "kiwisaver_employer")) {
    throw new ValidationError(`Every organisation has one ${PAY_ITEM_KIND_LABELS[input]} pay item; change that one instead.`);
  }
  if (typeof input !== "string" || !(ADDABLE_PAY_ITEM_KINDS as readonly string[]).includes(input)) {
    throw new ValidationError(
      `Kind must be one of: ${ADDABLE_PAY_ITEM_KINDS.join(", ")}. Bonuses, back pay, final pays, leave, child support and payroll giving are ${NOT_SUPPORTED.toLowerCase()}.`,
    );
  }
  return input as AddableKind;
}

function parseName(input: unknown): string {
  return requireString(input, "Name", { maxLength: 100 });
}

/** Earnings and employer contributions go to expense (or direct costs) accounts, deductions to liabilities (PRUN10). */
async function resolveAccount(tx: OrgTx, code: unknown, category: PayItemCategory, keptId: string | null): Promise<string> {
  const accountCode = requireString(code, "Account", { maxLength: 20 });
  const found = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: string;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>("select id::text, code, name, account_class, system_key, currency_code, is_active from accounts where lower(code) = lower($1)", [
    accountCode,
  ]);
  const account = found.rows[0];
  if (!account) throw new ValidationError(`There's no account with the code ${accountCode}.`);
  const label = `Account ${account.code} (${account.name})`;
  if (!account.is_active && account.id !== keptId) throw new ValidationError(`${label} is archived.`);
  if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label} is in ${account.currency_code}; pay items need base currency accounts.`);
  }
  if (category === "deduction") {
    if (account.account_class !== "liability") {
      throw new ValidationError(`${label} isn't a liability account. Deductions are owed to someone else, so they go to a liability account.`);
    }
    if (account.system_key !== null && account.system_key !== "payroll_deductions_payable") {
      throw new ValidationError(`${label} is a control account, so pay items can't use it.`);
    }
  } else {
    if (account.account_class !== "expense") {
      throw new ValidationError(`${label} isn't an expense account. Earnings and employer contributions go to expense or direct costs accounts.`);
    }
    if (account.system_key !== null) {
      throw new ValidationError(`${label} is a control account, so pay items can't use it.`);
    }
  }
  return account.id;
}

function parseMultiplier(input: unknown): string {
  const text = parseDecimalInput(input, "Rate multiplier", { maxScale: 4 });
  if (cmp(dec(text), ZERO_DECIMAL) <= 0 || cmp(dec(text), dec("10")) > 0) {
    throw new ValidationError("Rate multiplier must be more than 0 and at most 10 (1.5 for time and a half).");
  }
  return text;
}

type Treatment = { paye: boolean; kiwiSaver: boolean };

/** What a kind is subject to (spec 5.7, 5.11, 4.5.1); only allowances vary. */
function treatmentFor(kind: AddableKind, input: Record<string, unknown>): Treatment {
  if (kind === "allowance") {
    const paye = input.taxable === undefined ? true : requireBoolean(input.taxable, "Taxable");
    const kiwiSaver = input.countsForKiwiSaver === undefined ? paye : requireBoolean(input.countsForKiwiSaver, "Counts for KiwiSaver");
    if (kiwiSaver && !paye) {
      throw new ValidationError("An allowance that isn't taxable doesn't count for KiwiSaver either (spec 4.5.1).");
    }
    return { paye, kiwiSaver };
  }
  if (input.taxable !== undefined || input.countsForKiwiSaver !== undefined) {
    const fixed = kind === "overtime" || kind === "holiday_pay";
    const paye = input.taxable === undefined ? fixed : requireBoolean(input.taxable, "Taxable");
    const kiwiSaver = input.countsForKiwiSaver === undefined ? fixed : requireBoolean(input.countsForKiwiSaver, "Counts for KiwiSaver");
    if (paye !== fixed || kiwiSaver !== fixed) {
      if (kind === "reimbursement" && paye) {
        throw new ValidationError(
          `${NOT_SUPPORTED}: a reimbursement that is taxed. Reimbursements of actual costs aren't taxed (spec 5.7); use a taxable allowance.`,
        );
      }
      throw new ValidationError(`${PAY_ITEM_KIND_LABELS[kind]} pay items are ${fixed ? "always" : "never"} taxable and ${fixed ? "always" : "never"} count for KiwiSaver.`);
    }
  }
  return kind === "overtime" || kind === "holiday_pay" ? { paye: true, kiwiSaver: true } : { paye: false, kiwiSaver: false };
}

function assertAllTaxesTogether(input: Record<string, unknown>): void {
  for (const field of ["subjectToAccLevy", "subjectToStudentLoan"] as const) {
    if (input[field] !== undefined) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: setting the ACC earners' levy or student loan apart from PAYE. A taxable pay item is subject to all three.`,
      );
    }
  }
}

async function assertNameFree(tx: OrgTx, name: string, exceptId: string | null): Promise<void> {
  const clash = await tx.query("select 1 from payroll_pay_items where lower(name) = lower($1) and ($2::uuid is null or id <> $2)", [
    name,
    exceptId,
  ]);
  if (clash.rows[0]) throw new ConflictError(`There's already a pay item called ${name}.`);
}

/** Adds a pay item (admins with payroll access; the route checks the role). */
export async function createPayItem(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; payItem: PayItem }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_pay_item", input);
  const replay = async () => {
    const earlier = await tx.query<PayItemRow>(`select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM} where p.idempotency_key = $1`, [
      idempotencyKey,
    ]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "pay item");
    return { created: false, payItem: toPayItem(earlier.rows[0]) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const kind = parseKind(input.kind);
  const category = CATEGORY_OF[kind];
  assertAllTaxesTogether(input);
  const treatment = treatmentFor(kind, input);
  const name = parseName(input.name);
  const accountId = await resolveAccount(tx, input.accountCode, category, null);
  const rateMultiplier = kind === "overtime" ? parseMultiplier(input.rateMultiplier ?? "1.5") : null;
  if (kind !== "overtime" && input.rateMultiplier !== undefined && input.rateMultiplier !== null) {
    throw new ValidationError("Only overtime pay items have a rate multiplier.");
  }
  await assertNameFree(tx, name, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_pay_items (
       idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
       subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9, false)
     on conflict (idempotency_key) do nothing returning id`,
    [idempotencyKey, hash, name, category, kind, accountId, rateMultiplier, treatment.paye, treatment.kiwiSaver],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError("The pay item couldn't be saved. Try again with a new idempotency key.");
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_item.created",
    entityType: "payroll_pay_item",
    entityId: id,
    details: { name, kind, taxable: treatment.paye, countsForKiwiSaver: treatment.kiwiSaver },
  });
  return { created: true, payItem: toPayItem(await findPayItem(tx, id)) };
}

/**
 * Changes a pay item's name, account, rate multiplier (overtime) or whether
 * it's archived. The kind and tax treatment don't change (earlier pay runs
 * were calculated with them); add a new item instead. Ordinary time and the
 * KiwiSaver employer contribution can only be renamed or re-pointed.
 */
export async function updatePayItem(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<{ payItem: PayItem }> {
  await requirePayrollAccess(tx);
  const current = await findPayItem(tx, id, true);
  for (const field of ["kind", "category", "taxable", "countsForKiwiSaver", "subjectToAccLevy", "subjectToStudentLoan"]) {
    if (input[field] !== undefined) {
      throw new ValidationError("A pay item's kind and tax treatment can't change, because earlier pay runs used them. Add a new pay item instead.");
    }
  }
  const name = input.name === undefined ? current.name : parseName(input.name);
  const accountId = input.accountCode === undefined ? current.account_id : await resolveAccount(tx, input.accountCode, current.category, current.account_id);
  const isArchived = input.isArchived === undefined ? current.is_archived : requireBoolean(input.isArchived, "isArchived");
  if (current.is_system && isArchived) {
    throw new ValidationError(`${current.name} is needed for every pay run, so it can't be archived.`);
  }
  let rateMultiplier = current.rate_multiplier;
  if (input.rateMultiplier !== undefined) {
    if (current.kind !== "overtime") throw new ValidationError("Only overtime pay items have a rate multiplier.");
    rateMultiplier = parseMultiplier(input.rateMultiplier);
  }
  if (name.toLowerCase() !== current.name.toLowerCase()) await assertNameFree(tx, name, id);
  await tx.query(
    `update payroll_pay_items set name = $2, account_id = $3, rate_multiplier = $4, is_archived = $5, updated_at = now() where id = $1`,
    [id, name, accountId, rateMultiplier, isArchived],
  );
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_item.updated",
    entityType: "payroll_pay_item",
    entityId: id,
    details: { changedFields: Object.keys(input).filter((field) => ["name", "accountCode", "rateMultiplier", "isArchived"].includes(field)) },
  });
  return { payItem: toPayItem(await findPayItem(tx, id)) };
}

/** Payroll settings (PRUN7). */
export type PayrollSettings = { approverMustDiffer: boolean };

export async function getPayrollSettings(tx: OrgTx): Promise<PayrollSettings> {
  await requirePayrollAccess(tx);
  const result = await tx.query<{ payroll_approver_must_differ: boolean }>(
    "select payroll_approver_must_differ from organisation_settings where id = true",
  );
  return { approverMustDiffer: result.rows[0]?.payroll_approver_must_differ ?? false };
}

/** Changes payroll settings (admins with payroll access; the route checks the role). */
export async function updatePayrollSettings(tx: OrgTx, input: Record<string, unknown>): Promise<PayrollSettings> {
  await requirePayrollAccess(tx);
  const approverMustDiffer = requireBoolean(input.approverMustDiffer, "approverMustDiffer");
  const updated = await tx.query("update organisation_settings set payroll_approver_must_differ = $1 where id = true", [approverMustDiffer]);
  if (updated.rowCount !== 1) throw new NotFoundError("The organisation's settings weren't found.");
  await writeAuditEvent(tx, {
    eventType: "payroll_settings.updated",
    entityType: "organisation_settings",
    entityId: "payroll",
    details: { approverMustDiffer },
  });
  return { approverMustDiffer };
}
