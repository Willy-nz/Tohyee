import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { type IrdPaymentFrequency, parseIrdPaymentFrequency } from "@/lib/payroll/ird-due-dates";
import { NOT_SUPPORTED } from "@/lib/payroll/rates";
import { requireBoolean, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Pay items (example PRUN10): the earnings, after-tax deductions and
 * employer contributions a pay run is made of, each with its account and
 * its tax treatment per IRD's Payroll Calculations and Business Rules
 * Specification (5.7, 5.11, 5.12 and 4.5.1). Every organisation starts with a set
 * (migration 0058); admins with payroll access add more. "Taxable" means
 * PAYE, the ACC earners' levy and the student loan deduction together,
 * except redundancy, which has no levy (decision 125). Extra pays, back pay,
 * holiday pay on finishing and redundancy are taxed under IRD's extra pay
 * rules (P12). Archived, never deleted.
 */

export const PAY_ITEM_CATEGORIES = ["earnings", "deduction", "employer_contribution"] as const;
export type PayItemCategory = (typeof PAY_ITEM_CATEGORIES)[number];

export const PAY_ITEM_KINDS = [
  "ordinary_time",
  "overtime",
  "allowance",
  "holiday_pay",
  "reimbursement",
  "extra_pay",
  "back_pay",
  "termination_holiday_pay",
  "redundancy",
  "after_tax_deduction",
  "kiwisaver_employer",
  "annual_leave",
  "sick_leave",
  "bereavement_leave",
  "family_violence_leave",
  "public_holiday",
  "public_holiday_worked",
  "alternative_holiday",
  "annual_leave_cash_up",
  "alternative_holiday_payout",
] as const;
export type PayItemKind = (typeof PAY_ITEM_KINDS)[number];

/**
 * Leave pay items (P8; decision 138): one each, made by Tohyee, used only
 * on lines Tohyee works out from leave bookings, public holidays, cash-ups,
 * exchanges and holiday pay on finishing. Never typed.
 */
export const LEAVE_PAY_ITEM_KINDS: readonly PayItemKind[] = [
  "annual_leave",
  "sick_leave",
  "bereavement_leave",
  "family_violence_leave",
  "public_holiday",
  "public_holiday_worked",
  "alternative_holiday",
  "annual_leave_cash_up",
  "alternative_holiday_payout",
];

/** The kinds an admin can add; the others come with the organisation. */
export const ADDABLE_PAY_ITEM_KINDS = [
  "overtime",
  "allowance",
  "holiday_pay",
  "reimbursement",
  "extra_pay",
  "back_pay",
  "termination_holiday_pay",
  "redundancy",
  "after_tax_deduction",
] as const;

/** Kinds taxed under IRD's extra pay rules (spec 5.11, 5.12; decision 125). */
export const EXTRA_PAY_KINDS: readonly PayItemKind[] = [
  "extra_pay",
  "back_pay",
  "termination_holiday_pay",
  "redundancy",
  // Cashed-up annual leave and alternative holidays exchanged for money are paid on top of regular pay (decision 151).
  "annual_leave_cash_up",
  "alternative_holiday_payout",
];
/** Kinds that arise from employment ending: only on a final pay, taxed by spec 5.12 (decision 130). */
export const TERMINATION_KINDS: readonly PayItemKind[] = ["termination_holiday_pay", "redundancy"];

/** The pay runs' order of kinds (journal lines, reports). */
export const PAY_ITEM_KIND_ORDER_SQL = `array['ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'annual_leave', 'sick_leave',
  'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked', 'alternative_holiday', 'annual_leave_cash_up',
  'alternative_holiday_payout', 'extra_pay', 'back_pay', 'termination_holiday_pay', 'redundancy', 'reimbursement', 'after_tax_deduction',
  'kiwisaver_employer']`;
type AddableKind = (typeof ADDABLE_PAY_ITEM_KINDS)[number];

/** Kinds that are refused rather than guessed (PRUN8), with what they are and when they come. */
const LEAVE_ITEMS_MESSAGE = "Leave pay items come with the organisation (one of each, Payroll › Pay items) and Tohyee works out their lines from leave under Payroll › Leave.";
const REFUSED_KINDS: Record<string, string> = {
  leave: "",
  annual_leave: "",
  sick_leave: "",
  bereavement_leave: "",
  family_violence_leave: "",
  public_holiday: "",
  public_holiday_worked: "",
  alternative_holiday: "",
  annual_leave_cash_up: "",
  alternative_holiday_payout: "",
  child_support: "child support deductions",
  payroll_giving: "payroll giving",
  employer_contribution: "employer contributions other than KiwiSaver",
  superannuation: "employer contributions other than KiwiSaver",
};

export const PAY_ITEM_KIND_LABELS: Record<PayItemKind, string> = {
  ordinary_time: "Ordinary time",
  overtime: "Overtime",
  allowance: "Allowance",
  holiday_pay: "Holiday pay for leave in this pay period (typed amount)",
  reimbursement: "Reimbursement",
  extra_pay: "Extra pay (bonus, gratuity, lump sum)",
  back_pay: "Back pay",
  termination_holiday_pay: "Holiday pay on finishing (worked out outside Tohyee)",
  redundancy: "Redundancy",
  after_tax_deduction: "After-tax deduction",
  kiwisaver_employer: "KiwiSaver employer contribution",
  annual_leave: "Annual holidays taken",
  sick_leave: "Sick leave",
  bereavement_leave: "Bereavement leave",
  family_violence_leave: "Family violence leave",
  public_holiday: "Public holiday not worked",
  public_holiday_worked: "Public holiday worked (time and a half)",
  alternative_holiday: "Alternative holiday taken",
  annual_leave_cash_up: "Annual holidays cashed up",
  alternative_holiday_payout: "Alternative holiday exchanged for payment",
};

const CATEGORY_OF: Record<PayItemKind, PayItemCategory> = {
  ordinary_time: "earnings",
  overtime: "earnings",
  allowance: "earnings",
  holiday_pay: "earnings",
  reimbursement: "earnings",
  extra_pay: "earnings",
  back_pay: "earnings",
  termination_holiday_pay: "earnings",
  redundancy: "earnings",
  after_tax_deduction: "deduction",
  kiwisaver_employer: "employer_contribution",
  annual_leave: "earnings",
  sick_leave: "earnings",
  bereavement_leave: "earnings",
  family_violence_leave: "earnings",
  public_holiday: "earnings",
  public_holiday_worked: "earnings",
  alternative_holiday: "earnings",
  annual_leave_cash_up: "earnings",
  alternative_holiday_payout: "earnings",
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
  /** Gross earnings for holiday pay (s 14; decision 139). */
  countsForHolidayPay: boolean;
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
  counts_for_holiday_pay: boolean;
  is_system: boolean;
  is_archived: boolean;
  request_hash: string;
};

export const PAY_ITEM_COLUMNS = `p.id, p.name, p.category, p.kind, p.account_id::text, a.code as account_code, a.name as account_name,
  p.rate_multiplier::text, p.subject_to_paye, p.subject_to_acc_levy, p.subject_to_student_loan, p.subject_to_kiwisaver,
  p.subject_to_esct, p.counts_for_holiday_pay, p.is_system, p.is_archived, p.request_hash`;

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
    countsForHolidayPay: row.counts_for_holiday_pay,
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
               array_position(${PAY_ITEM_KIND_ORDER_SQL}, p.kind),
               lower(p.name), p.id`,
    [options.includeArchived ?? false],
  );
  return result.rows.map(toPayItem);
}

function parseKind(input: unknown): AddableKind {
  if (typeof input === "string" && REFUSED_KINDS[input] === "") throw new ValidationError(LEAVE_ITEMS_MESSAGE);
  if (typeof input === "string" && REFUSED_KINDS[input]) {
    throw new ValidationError(`${NOT_SUPPORTED}: pay items for ${REFUSED_KINDS[input]}.`);
  }
  if (typeof input === "string" && (input === "ordinary_time" || input === "kiwisaver_employer")) {
    throw new ValidationError(`Every organisation has one ${PAY_ITEM_KIND_LABELS[input]} pay item; change that one instead.`);
  }
  if (typeof input !== "string" || !(ADDABLE_PAY_ITEM_KINDS as readonly string[]).includes(input)) {
    throw new ValidationError(
      `Kind must be one of: ${ADDABLE_PAY_ITEM_KINDS.join(", ")} (bonuses and lump sums are extra_pay). Leave pay items come with the organisation; child support and payroll giving are ${NOT_SUPPORTED.toLowerCase()}.`,
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

type Treatment = { paye: boolean; kiwiSaver: boolean; accLevy: boolean };

/** Extra pays' fixed treatment (decision 125): redundancy has no levy and doesn't count for KiwiSaver. */
const EXTRA_PAY_TREATMENT: Partial<Record<AddableKind, Treatment>> = {
  extra_pay: { paye: true, kiwiSaver: true, accLevy: true },
  back_pay: { paye: true, kiwiSaver: true, accLevy: true },
  termination_holiday_pay: { paye: true, kiwiSaver: true, accLevy: true },
  redundancy: { paye: true, kiwiSaver: false, accLevy: false },
};

/** What a kind is subject to (spec 5.7, 5.11, 4.5.1); only allowances vary. */
function treatmentFor(kind: AddableKind, input: Record<string, unknown>): Treatment {
  const extra = EXTRA_PAY_TREATMENT[kind];
  if (extra) {
    for (const [field, value] of [["taxable", extra.paye], ["countsForKiwiSaver", extra.kiwiSaver]] as const) {
      if (input[field] !== undefined && requireBoolean(input[field], field) !== value) {
        throw new ValidationError(
          `${PAY_ITEM_KIND_LABELS[kind]} pay items are taxable and ${extra.kiwiSaver ? "count" : "don't count"} for KiwiSaver (decision 125).`,
        );
      }
    }
    return extra;
  }
  if (kind === "allowance") {
    const paye = input.taxable === undefined ? true : requireBoolean(input.taxable, "Taxable");
    const kiwiSaver = input.countsForKiwiSaver === undefined ? paye : requireBoolean(input.countsForKiwiSaver, "Counts for KiwiSaver");
    if (kiwiSaver && !paye) {
      throw new ValidationError("An allowance that isn't taxable doesn't count for KiwiSaver either (spec 4.5.1).");
    }
    return { paye, kiwiSaver, accLevy: paye };
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
  return kind === "overtime" || kind === "holiday_pay"
    ? { paye: true, kiwiSaver: true, accLevy: true }
    : { paye: false, kiwiSaver: false, accLevy: false };
}

/**
 * Whether a new pay item's payments are gross earnings for holiday pay
 * (s 14; decision 139): taxable earnings are, except redundancy (Employment
 * NZ: compensation, not earnings); an extra pay or allowance the employment
 * agreement doesn't bind the employer to pay is "discretionary" and isn't
 * (s 14(b)(i)).
 */
function holidayGrossFor(kind: AddableKind, treatment: Treatment, discretionaryInput: unknown): boolean {
  const discretionary = discretionaryInput === undefined || discretionaryInput === null ? false : requireBoolean(discretionaryInput, "discretionary");
  if (discretionary && kind !== "extra_pay" && kind !== "allowance") {
    throw new ValidationError("Only extra pays and allowances can be discretionary (payments the employment agreement doesn't bind the employer to pay).");
  }
  if (!treatment.paye || kind === "redundancy" || kind === "reimbursement") return false;
  return !discretionary;
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
  const countsForHolidayPay = holidayGrossFor(kind, treatment, input.discretionary);
  const rateMultiplier = kind === "overtime" ? parseMultiplier(input.rateMultiplier ?? "1.5") : null;
  if (kind !== "overtime" && input.rateMultiplier !== undefined && input.rateMultiplier !== null) {
    throw new ValidationError("Only overtime pay items have a rate multiplier.");
  }
  await assertNameFree(tx, name, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_pay_items (
       idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
       subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, counts_for_holiday_pay
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $10, $8, $9, false, $11)
     on conflict (idempotency_key) do nothing returning id`,
    [idempotencyKey, hash, name, category, kind, accountId, rateMultiplier, treatment.paye, treatment.kiwiSaver, treatment.accLevy, countsForHolidayPay],
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
    details: { name, kind, taxable: treatment.paye, countsForKiwiSaver: treatment.kiwiSaver, countsForHolidayPay },
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
  for (const field of ["kind", "category", "taxable", "countsForKiwiSaver", "subjectToAccLevy", "subjectToStudentLoan", "discretionary"]) {
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

/**
 * Payroll settings (PRUN7, PPAY9), and the two accounts the leave liability
 * is posted to (decision 184; HL56): an expense account for the leave
 * expense and a current liability account for employee entitlements.
 */
export type PayrollSettings = {
  approverMustDiffer: boolean;
  irdPaymentFrequency: IrdPaymentFrequency;
  leaveExpenseAccountCode: string | null;
  leaveLiabilityAccountCode: string | null;
};

type SettingsRow = {
  payroll_approver_must_differ: boolean;
  payroll_ird_payment_frequency: IrdPaymentFrequency;
  payroll_leave_expense_account_id: string | null;
  payroll_leave_liability_account_id: string | null;
  leave_expense_code: string | null;
  leave_liability_code: string | null;
};

async function settingsRow(tx: OrgTx): Promise<SettingsRow | undefined> {
  const result = await tx.query<SettingsRow>(
    `select s.payroll_approver_must_differ, s.payroll_ird_payment_frequency,
            s.payroll_leave_expense_account_id::text, s.payroll_leave_liability_account_id::text,
            e.code as leave_expense_code, l.code as leave_liability_code
       from organisation_settings s
       left join accounts e on e.id = s.payroll_leave_expense_account_id
       left join accounts l on l.id = s.payroll_leave_liability_account_id
      where s.id = true`,
  );
  return result.rows[0];
}

async function readPayrollSettings(tx: OrgTx): Promise<PayrollSettings> {
  const row = await settingsRow(tx);
  return {
    approverMustDiffer: row?.payroll_approver_must_differ ?? false,
    irdPaymentFrequency: row?.payroll_ird_payment_frequency ?? "monthly",
    leaveExpenseAccountCode: row?.leave_expense_code ?? null,
    leaveLiabilityAccountCode: row?.leave_liability_code ?? null,
  };
}

export async function getPayrollSettings(tx: OrgTx): Promise<PayrollSettings> {
  await requirePayrollAccess(tx);
  return readPayrollSettings(tx);
}

/** The leave liability accounts' ids (decision 184), or null where not set. */
export async function leaveLiabilityAccountIds(tx: OrgTx): Promise<{ expenseAccountId: string | null; liabilityAccountId: string | null }> {
  const row = await settingsRow(tx);
  return { expenseAccountId: row?.payroll_leave_expense_account_id ?? null, liabilityAccountId: row?.payroll_leave_liability_account_id ?? null };
}

/**
 * Checks an account for the leave liability (decision 184): base currency,
 * active, not a control account; the expense an expense (or direct costs)
 * account, the entitlements a current liability.
 */
async function resolveLeaveAccount(tx: OrgTx, code: unknown, which: "expense" | "liability", keptId: string | null): Promise<string> {
  const accountCode = requireString(code, which === "expense" ? "Leave expense account" : "Employee entitlements account", { maxLength: 20 });
  const found = await tx.query<{ id: string; code: string; name: string; account_class: string; account_type: string; system_key: string | null; currency_code: string | null; is_active: boolean }>(
    "select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = lower($1)",
    [accountCode],
  );
  const account = found.rows[0];
  if (!account) throw new ValidationError(`There's no account with the code ${accountCode}.`);
  const label = `Account ${account.code} (${account.name})`;
  if (!account.is_active && account.id !== keptId) throw new ValidationError(`${label} is archived.`);
  if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label} is in ${account.currency_code}; the leave liability is posted in the base currency.`);
  }
  if (account.system_key !== null) throw new ValidationError(`${label} is a control account, so the leave liability can't use it.`);
  if (which === "expense" && account.account_class !== "expense") {
    throw new ValidationError(`${label} isn't an expense account. The leave expense goes to an expense or direct costs account.`);
  }
  if (which === "liability" && account.account_type !== "current_liability") {
    throw new ValidationError(`${label} isn't a current liability account. Employee entitlements are a current liability (short-term employee benefits).`);
  }
  return account.id;
}

/**
 * Changes payroll settings (admins with payroll access; the route checks the
 * role). Each setting left out stays as it is. How often IRD is paid is
 * monthly, or twice a month for employers IRD has told to (PPAY9). The
 * employee entitlements account can't change while the last leave
 * liability posting not voided left a liability in it (decision 184).
 */
export async function updatePayrollSettings(tx: OrgTx, input: Record<string, unknown>): Promise<PayrollSettings> {
  await requirePayrollAccess(tx);
  const fields = ["approverMustDiffer", "irdPaymentFrequency", "leaveExpenseAccountCode", "leaveLiabilityAccountCode"];
  if (fields.every((field) => input[field] === undefined)) {
    throw new ValidationError(`Give ${fields.join(", ")} or more.`);
  }
  await tx.query("select 1 from organisation_settings where id = true for update");
  const current = await readPayrollSettings(tx);
  const ids = await leaveLiabilityAccountIds(tx);
  const approverMustDiffer = input.approverMustDiffer === undefined ? current.approverMustDiffer : requireBoolean(input.approverMustDiffer, "approverMustDiffer");
  const irdPaymentFrequency =
    input.irdPaymentFrequency === undefined ? current.irdPaymentFrequency : parseIrdPaymentFrequency(input.irdPaymentFrequency);
  const blank = (value: unknown) => value === null || value === "";
  const expenseAccountId =
    input.leaveExpenseAccountCode === undefined
      ? ids.expenseAccountId
      : blank(input.leaveExpenseAccountCode)
        ? null
        : await resolveLeaveAccount(tx, input.leaveExpenseAccountCode, "expense", ids.expenseAccountId);
  const liabilityAccountId =
    input.leaveLiabilityAccountCode === undefined
      ? ids.liabilityAccountId
      : blank(input.leaveLiabilityAccountCode)
        ? null
        : await resolveLeaveAccount(tx, input.leaveLiabilityAccountCode, "liability", ids.liabilityAccountId);
  if (liabilityAccountId !== ids.liabilityAccountId) {
    const last = await tx.query<{ posting_number: string; liability: string }>(
      `select posting_number::text, (liability + kiwisaver)::text as liability from payroll_leave_liability_postings
        where status = 'active' order by posting_number desc limit 1`,
    );
    if (last.rows[0] && cmp(dec(last.rows[0].liability), ZERO_DECIMAL) !== 0) {
      throw new ConflictError(
        `LEAVELIAB-${last.rows[0].posting_number} left the leave liability in ${current.leaveLiabilityAccountCode ?? "the employee entitlements account"}, so that account can't change until a posting brings it to 0.00 or the postings are voided (decision 184).`,
      );
    }
  }
  const updated = await tx.query(
    `update organisation_settings
        set payroll_approver_must_differ = $1, payroll_ird_payment_frequency = $2,
            payroll_leave_expense_account_id = $3, payroll_leave_liability_account_id = $4
      where id = true`,
    [approverMustDiffer, irdPaymentFrequency, expenseAccountId, liabilityAccountId],
  );
  if (updated.rowCount !== 1) throw new NotFoundError("The organisation's settings weren't found.");
  const settings = await readPayrollSettings(tx);
  await writeAuditEvent(tx, {
    eventType: "payroll_settings.updated",
    entityType: "organisation_settings",
    entityId: "payroll",
    details: settings,
  });
  return settings;
}
