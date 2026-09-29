import type { AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import {
  addMonths,
  adjustByPercent,
  BUDGET_LIMITS,
  fillSameAmount,
  MONTH_PATTERN,
  monthEndDate,
  monthRange,
  monthStartDate,
  type QuickFillMethod,
} from "@/lib/budgets/fill";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isZero, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, financialYearEndMonth, naturalAmount, type TrackingFilter } from "@/lib/reports/financial";
import { advancedFeaturesOn, valueWithDescendants } from "@/lib/tracking/service";
import { optionalId, optionalSource, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Budgets (examples BU1-BU8), like Xero's budget manager: the overall budget
 * and named budgets, optionally for one tracking value, each an amount per
 * profit and loss account per month in the account's natural direction
 * (income as credits, costs as debits). Budgets post nothing; they're
 * archived, never deleted, and every change of amounts is in the audit log
 * with the amounts before and after.
 */

export type Budget = {
  id: string;
  name: string;
  isOverall: boolean;
  trackingValueId: string | null;
  trackingCategoryId: string | null;
  /** e.g. "Department: Retail". */
  trackingLabel: string | null;
  version: number;
  archivedAt: string | null;
  archivedByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string;
};

export type BudgetGridAccount = {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  isActive: boolean;
  /** One per month of the grid. */
  amounts: string[];
  total: string;
};

export type BudgetGrid = {
  budget: Budget;
  currencyCode: string;
  months: string[];
  accounts: BudgetGridAccount[];
  totals: string[];
};

type BudgetRow = {
  id: string;
  name: string;
  is_overall: boolean;
  tracking_value_id: string | null;
  tracking_category_id: string | null;
  category_name: string | null;
  value_name: string | null;
  version: number;
  archived_at: string | null;
  archived_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_by_email: string | null;
  updated_at: string;
};

const SELECT = `select b.id::text, b.name, b.is_overall, b.tracking_value_id::text, v.category_id::text as tracking_category_id,
       c.name as category_name, v.name as value_name, b.version, b.archived_at, b.archived_by_email,
       b.created_by_email, b.created_at, b.updated_by_email, b.updated_at
  from budgets b
  left join tracking_values v on v.id = b.tracking_value_id
  left join tracking_categories c on c.id = v.category_id`;

function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    name: row.name,
    isOverall: row.is_overall,
    trackingValueId: row.tracking_value_id,
    trackingCategoryId: row.tracking_category_id,
    trackingLabel: row.value_name ? `${row.category_name}: ${row.value_name}` : null,
    version: row.version,
    archivedAt: row.archived_at,
    archivedByEmail: row.archived_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

async function findBudget(tx: OrgTx, id: string, lock = false): Promise<Budget> {
  if (lock) await tx.query("select 1 from budgets where id = $1 for update", [id]);
  const found = await tx.query<BudgetRow>(`${SELECT} where b.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Budget not found.");
  return toBudget(found.rows[0]);
}

export async function getBudgetSummary(tx: OrgTx, idInput: unknown): Promise<Budget> {
  return findBudget(tx, requireId(idInput, "budgetId"));
}

/** Budgets, the overall one first; archived ones only when asked (BU1). */
export async function listBudgets(tx: OrgTx, input: { archived?: unknown } = {}): Promise<Budget[]> {
  const archived = input.archived === true || input.archived === "true";
  const found = await tx.query<BudgetRow>(
    `${SELECT} where (b.archived_at is not null) = $1 order by b.is_overall desc, lower(b.name), b.id`,
    [archived],
  );
  return found.rows.map(toBudget);
}

function parseName(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new ValidationError("A budget needs a name.");
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length > BUDGET_LIMITS.nameLength) throw new ValidationError(`A budget's name can be at most ${BUDGET_LIMITS.nameLength} characters.`);
  return name;
}

export function parseMonth(input: unknown, what: string): string {
  if (typeof input !== "string" || !MONTH_PATTERN.test(input.trim())) {
    throw new ValidationError(`${what} must be a month like 2026-04.`);
  }
  return input.trim();
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === "23505" && (!constraint || e.constraint === constraint);
}

function nameTaken(name: string): ConflictError {
  return new ConflictError(`There's already a budget called ${name}. Choose another name.`);
}

/** Starts a named budget, optionally for one tracking value (BU1). */
export async function createBudget(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; name: unknown; trackingValueId?: unknown },
): Promise<{ created: boolean; budget: Budget }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const name = parseName(command.name);
  const trackingValueId = optionalId(command.trackingValueId, "trackingValueId");
  const hash = requestHash("budget_create", { name, trackingValueId });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from budgets where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "budget");
    return { created: false, budget: await findBudget(tx, earlier.rows[0].id) };
  }
  if (trackingValueId) {
    if (!(await advancedFeaturesOn(tx))) {
      throw new ValidationError("Advanced reporting is off, so a budget can't be for a tracking value. Turn it on in Settings first.");
    }
    const value = await tx.query<{ name: string; is_active: boolean }>("select name, is_active from tracking_values where id = $1", [trackingValueId]);
    if (!value.rows[0]) throw new ValidationError("There's no such tracking value.");
    if (!value.rows[0].is_active) throw new ValidationError(`${value.rows[0].name} is archived, so a new budget can't use it.`);
  }
  let id: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into budgets (command_source, idempotency_key, request_hash, name, tracking_value_id, created_by_user_id, created_by_email, updated_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id::text`,
      [source, idempotencyKey, hash, name, trackingValueId, tx.actor.userId, tx.actor.email],
    );
    id = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error, "budgets_name_key")) throw nameTaken(name);
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different budget. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "budget.created", entityType: "budget", entityId: id, details: { name, trackingValueId } });
  return { created: true, budget: await findBudget(tx, id) };
}

function assertChangeable(budget: Budget, version: unknown): void {
  if (budget.archivedAt) throw new ConflictError(`${budget.name} is archived. Bring it back to change it.`);
  if (version !== budget.version) {
    throw new ConflictError("Someone else has changed this budget since you opened it. Reload it to see their changes.");
  }
}

/** Renames a budget. */
export async function renameBudget(tx: OrgTx, idInput: unknown, command: { name: unknown; version: unknown }): Promise<Budget> {
  const id = requireId(idInput, "budgetId");
  const budget = await findBudget(tx, id, true);
  assertChangeable(budget, command.version);
  const name = parseName(command.name);
  if (name === budget.name) return budget;
  try {
    await tx.query("update budgets set name = $2, version = version + 1, updated_by_email = $3, updated_at = now() where id = $1", [id, name, tx.actor.email]);
  } catch (error) {
    if (isUniqueViolation(error, "budgets_name_key")) throw nameTaken(name);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "budget.renamed", entityType: "budget", entityId: id, details: { from: budget.name, to: name } });
  return findBudget(tx, id);
}

/** Archives a named budget or brings it back (BU1). The overall budget is never archived. */
export async function setBudgetArchived(tx: OrgTx, idInput: unknown, archived: boolean): Promise<Budget> {
  const id = requireId(idInput, "budgetId");
  const budget = await findBudget(tx, id, true);
  if (budget.isOverall && archived) throw new ConflictError("The overall budget can't be archived.");
  if (Boolean(budget.archivedAt) === archived) return budget;
  try {
    await tx.query(
      archived
        ? "update budgets set archived_at = now(), archived_by_email = $2, version = version + 1 where id = $1"
        : "update budgets set archived_at = null, archived_by_email = null, version = version + 1 where id = $1",
      archived ? [id, tx.actor.email] : [id],
    );
  } catch (error) {
    if (isUniqueViolation(error, "budgets_name_key")) {
      throw new ConflictError(`Another budget is now called ${budget.name}. Rename that one first, then bring this one back.`);
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: archived ? "budget.archived" : "budget.restored",
    entityType: "budget",
    entityId: id,
    details: { name: budget.name },
  });
  return findBudget(tx, id);
}

type PlAccount = { id: string; code: string; name: string; account_type: AccountType; is_active: boolean };

async function profitAndLossAccounts(tx: OrgTx): Promise<PlAccount[]> {
  const found = await tx.query<PlAccount>(
    "select id::text, code, name, account_type, is_active from accounts where account_class in ('revenue', 'expense') order by code",
  );
  return found.rows;
}

/** The budget's grid: every profit and loss account, `months` months from `from` (default: this financial year). */
export async function getBudget(tx: OrgTx, idInput: unknown, input: { from?: unknown; months?: unknown } = {}): Promise<BudgetGrid> {
  const budget = await findBudget(tx, requireId(idInput, "budgetId"));
  const from =
    input.from == null || input.from === ""
      ? financialYearStart(todayIsoDate(), await financialYearEndMonth(tx)).slice(0, 7)
      : parseMonth(input.from, "from");
  const count = input.months == null || input.months === "" ? 12 : Number(input.months);
  if (!Number.isInteger(count) || count < 1 || count > BUDGET_LIMITS.months) {
    throw new ValidationError(`Show 1 to ${BUDGET_LIMITS.months} months.`);
  }
  const months = monthRange(from, count);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const stored = await tx.query<{ account_id: string; month: string; amount: string }>(
    `select account_id::text, to_char(month, 'YYYY-MM') as month, amount::text from budget_amounts
      where budget_id = $1 and month between $2::date and $3::date`,
    [budget.id, monthStartDate(months[0]), monthStartDate(months[months.length - 1])],
  );
  const byKey = new Map(stored.rows.map((row) => [`${row.account_id}|${row.month}`, dec(row.amount)]));
  const totals = months.map(() => ZERO_DECIMAL);
  const accounts: BudgetGridAccount[] = [];
  for (const account of await profitAndLossAccounts(tx)) {
    const amounts = months.map((month) => byKey.get(`${account.id}|${month}`) ?? ZERO_DECIMAL);
    const hasAmount = amounts.some((amount) => !isZero(amount));
    if (!account.is_active && !hasAmount) continue;
    let total = ZERO_DECIMAL;
    amounts.forEach((amount, index) => {
      total = add(total, amount);
      totals[index] = add(totals[index], amount);
    });
    accounts.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountType: account.account_type,
      isActive: account.is_active,
      amounts: amounts.map((amount) => toFixedString(amount, scale)),
      total: toFixedString(total, scale),
    });
  }
  return { budget, currencyCode: tx.baseCurrency, months, accounts, totals: totals.map((total) => toFixedString(total, scale)) };
}

type AmountChange = { accountId: string; accountCode: string; month: string; amount: string };

async function resolveAccounts(tx: OrgTx, codes: string[]): Promise<Map<string, PlAccount & { account_class: string }>> {
  const found = await tx.query<PlAccount & { account_class: string }>(
    "select id::text, code, name, account_type, is_active, account_class from accounts where lower(code) = any($1::text[])",
    [[...new Set(codes.map((code) => code.toLowerCase()))]],
  );
  const byCode = new Map(found.rows.map((row) => [row.code.toLowerCase(), row]));
  for (const code of codes) {
    const account = byCode.get(code.toLowerCase());
    if (!account) throw new ValidationError(`There's no account with the code ${code}.`);
    if (account.account_class !== "revenue" && account.account_class !== "expense") {
      throw new ValidationError(`Account ${account.code} (${account.name}) isn't a profit and loss account. Budgets hold income and expense accounts only.`);
    }
  }
  return byCode;
}

/** Writes changed amounts and records them, before and after, in the audit log. */
async function applyAmounts(tx: OrgTx, budget: Budget, changes: AmountChange[], how: string): Promise<number> {
  const current = await tx.query<{ account_id: string; month: string; amount: string }>(
    `select account_id::text, to_char(month, 'YYYY-MM') as month, amount::text from budget_amounts
      where budget_id = $1 and (account_id::text || '|' || to_char(month, 'YYYY-MM')) = any($2::text[])`,
    [budget.id, changes.map((change) => `${change.accountId}|${change.month}`)],
  );
  const before = new Map(current.rows.map((row) => [`${row.account_id}|${row.month}`, row.amount]));
  const scale = currencyMinorUnits(tx.baseCurrency);
  const changed: Array<{ account: string; month: string; from: string; to: string }> = [];
  for (const change of changes) {
    const old = before.get(`${change.accountId}|${change.month}`) ?? "0";
    if (cmp(dec(old), dec(change.amount)) === 0) continue;
    await tx.query(
      `insert into budget_amounts (budget_id, account_id, month, amount, updated_by_email)
       values ($1, $2, $3::date, $4::numeric, $5)
       on conflict (budget_id, account_id, month) do update set amount = excluded.amount, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [budget.id, change.accountId, monthStartDate(change.month), change.amount, tx.actor.email],
    );
    changed.push({ account: change.accountCode, month: change.month, from: toFixedString(dec(old), scale), to: change.amount });
  }
  if (changed.length > 0) {
    await tx.query("update budgets set version = version + 1, updated_by_email = $2, updated_at = now() where id = $1", [budget.id, tx.actor.email]);
    await writeAuditEvent(tx, {
      eventType: "budget.amounts_changed",
      entityType: "budget",
      entityId: budget.id,
      details: { name: budget.name, how, changes: changed },
    });
  }
  return changed.length;
}

/**
 * Sets amounts (BU2): `amounts` is a list of { accountCode, month, amount }
 * in the account's natural direction. `version` must be the one loaded.
 */
export async function setBudgetAmounts(
  tx: OrgTx,
  idInput: unknown,
  command: { version: unknown; amounts: unknown },
): Promise<{ changed: number; budget: Budget }> {
  const id = requireId(idInput, "budgetId");
  const budget = await findBudget(tx, id, true);
  assertChangeable(budget, command.version);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const raw = requireArray(command.amounts, "amounts", BUDGET_LIMITS.amountsPerSave);
  const parsed = raw.map((entry, index) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (!item) throw new ValidationError(`Amount ${index + 1} is missing.`);
    if (typeof item.accountCode !== "string" || !item.accountCode.trim()) throw new ValidationError(`Amount ${index + 1} needs an account.`);
    const month = parseMonth(item.month, `Amount ${index + 1}'s month`);
    const amount = parseDecimalInput(item.amount == null || item.amount === "" ? "0" : item.amount, `The ${item.accountCode} amount for ${month}`, {
      maxScale: scale,
      allowNegative: true,
      allowZero: true,
    });
    return { accountCode: item.accountCode.trim(), month, amount: toFixedString(dec(amount), scale) };
  });
  const accounts = await resolveAccounts(tx, parsed.map((entry) => entry.accountCode));
  const seen = new Set<string>();
  const changes = parsed.map((entry) => {
    const account = accounts.get(entry.accountCode.toLowerCase())!;
    const key = `${account.id}|${entry.month}`;
    if (seen.has(key)) throw new ValidationError(`${account.code} has two amounts for ${entry.month}.`);
    seen.add(key);
    return { accountId: account.id, accountCode: account.code, month: entry.month, amount: entry.amount };
  });
  const changed = await applyAmounts(tx, budget, changes, "typed");
  return { changed, budget: await findBudget(tx, id) };
}

/** Each account's actual amount per month, in its natural direction, filtered to the budget's tracking value. */
async function actualsByMonth(tx: OrgTx, budget: Budget, months: string[]): Promise<Map<string, Decimal[]>> {
  const filter = await budgetTrackingFilter(tx, budget);
  const result = new Map<string, Decimal[]>();
  for (const [index, month] of months.entries()) {
    for (const row of await accountTotals(tx, monthStartDate(month), monthEndDate(month), filter)) {
      const amounts = result.get(row.id) ?? months.map(() => ZERO_DECIMAL);
      amounts[index] = naturalAmount(row);
      result.set(row.id, amounts);
    }
  }
  return result;
}

/** Only lines tagged with the budget's value or one under it, when it has one (BU4, BU6). */
export async function budgetTrackingFilter(tx: OrgTx, budget: Budget): Promise<TrackingFilter | null> {
  if (!budget.trackingValueId || !budget.trackingCategoryId) return null;
  return { categoryId: budget.trackingCategoryId, valueIds: await valueWithDescendants(tx, budget.trackingValueId) };
}

/**
 * Quick fill (BU3, BU4): for the chosen accounts, `months` months from
 * `from`, either the same amount each month (optionally changing by
 * `percent` each month) or the same months of last year's actuals
 * (optionally changed by `percent`), filtered to the budget's tracking
 * value. Replaces those months' amounts.
 */
export async function fillBudget(
  tx: OrgTx,
  idInput: unknown,
  command: { version: unknown; accountCodes: unknown; from: unknown; months: unknown; method: unknown; amount?: unknown; percent?: unknown },
): Promise<{ changed: number; budget: Budget }> {
  const id = requireId(idInput, "budgetId");
  const budget = await findBudget(tx, id, true);
  assertChangeable(budget, command.version);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const codes = requireArray(command.accountCodes, "accountCodes", 1000).map((code) => {
    if (typeof code !== "string" || !code.trim()) throw new ValidationError("Choose the accounts to fill.");
    return code.trim();
  });
  if (codes.length === 0) throw new ValidationError("Choose the accounts to fill.");
  const from = parseMonth(command.from, "from");
  const count = Number(command.months);
  if (!Number.isInteger(count) || count < 1 || count > BUDGET_LIMITS.months) throw new ValidationError(`Fill 1 to ${BUDGET_LIMITS.months} months.`);
  const method = command.method as QuickFillMethod;
  if (method !== "same" && method !== "actuals") throw new ValidationError("Fill with the same amount each month or last year's actuals.");
  let percent: string | null = null;
  if (command.percent != null && command.percent !== "") {
    percent = parseDecimalInput(command.percent, "The % change", { maxScale: 2, allowNegative: true, allowZero: true });
    if (cmp(dec(percent), dec(String(-BUDGET_LIMITS.percent))) < 0 || cmp(dec(percent), dec(String(BUDGET_LIMITS.percent))) > 0) {
      throw new ValidationError(`The % change must be between -${BUDGET_LIMITS.percent} and ${BUDGET_LIMITS.percent}.`);
    }
  }
  const accounts = await resolveAccounts(tx, codes);
  const months = monthRange(from, count);
  const changes: AmountChange[] = [];
  if (method === "same") {
    const amount = parseDecimalInput(command.amount, "The amount", { maxScale: scale, allowNegative: true, allowZero: true });
    const filled = fillSameAmount(amount, count, percent, scale);
    for (const code of codes) {
      const account = accounts.get(code.toLowerCase())!;
      months.forEach((month, index) => changes.push({ accountId: account.id, accountCode: account.code, month, amount: filled[index] }));
    }
  } else {
    const actuals = await actualsByMonth(tx, budget, months.map((month) => addMonths(month, -12)));
    for (const code of codes) {
      const account = accounts.get(code.toLowerCase())!;
      const amounts = actuals.get(account.id);
      months.forEach((month, index) =>
        changes.push({
          accountId: account.id,
          accountCode: account.code,
          month,
          amount: adjustByPercent(toFixedString(amounts?.[index] ?? ZERO_DECIMAL, scale), percent, scale),
        }),
      );
    }
  }
  const unique = new Map(changes.map((change) => [`${change.accountId}|${change.month}`, change]));
  const changed = await applyAmounts(tx, budget, [...unique.values()], method === "same" ? "same amount each month" : "last year's actuals");
  return { changed, budget: await findBudget(tx, id) };
}

/** Each account's budget over whole months from `from` to `to` (dates), in its natural direction. */
export async function budgetTotals(tx: OrgTx, budgetId: string, from: string, to: string): Promise<Map<string, Decimal>> {
  const found = await tx.query<{ account_id: string; amount: string }>(
    `select account_id::text, sum(amount)::text as amount from budget_amounts
      where budget_id = $1 and month between date_trunc('month', $2::date)::date and $3::date
      group by account_id`,
    [budgetId, from, to],
  );
  return new Map(found.rows.map((row) => [row.account_id, dec(row.amount)]));
}
