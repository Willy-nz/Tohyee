import { writeAuditEvent } from "@/lib/audit";
import { addMonths, monthEndDate, monthRange, monthStartDate } from "@/lib/budgets/fill";
import { getBudgetSummary, parseMonth, type WorkforceAmount, workforceOwnedAmounts, writeWorkforceAmounts } from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, type Decimal, isZero, parseDecimalInput, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { assertTotalsOneHundred, parseAllocationPercentage } from "@/lib/payroll/allocation-split";
import { listAllocations } from "@/lib/payroll/allocations";
import { firstPayRate, payRateOn } from "@/lib/payroll/pay-rates";
import { labourCostReport } from "@/lib/payroll/reports";
import {
  addMoney,
  lineFigures,
  type MonthFigures,
  splitMonth,
  WORKFORCE_LIMITS,
  type WorkforceLineMaths,
  type WorkforcePayBasis,
  type WorkforceRate,
} from "@/lib/payroll/workforce-figures";
import { requireUuid } from "@/lib/rd/common";
import { valueWithDescendants } from "@/lib/tracking/service";
import { asRecord, optionalId, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Workforce budgets (payroll stage P11; examples WB1-WB7, decisions
 * 112-123): wages by employee or position and month, split by Department
 * (an employee by their cost allocation, a position by its own split), and
 * written into the budgets they feed as wages and employer KiwiSaver
 * amounts that only the workforce budget can change. Payroll access only;
 * nothing is posted.
 */

export type WorkforceSplit = { percentage: string; departmentId: string | null; departmentName: string | null; projectId: string | null; projectName: string | null };

export type WorkforceLine = {
  id: string;
  lineNumber: number;
  employeeId: string | null;
  employeeName: string | null;
  positionName: string | null;
  payBasis: WorkforcePayBasis;
  fte: string | null;
  hoursPerWeek: string | null;
  kiwiSaverRate: string;
  startMonth: string;
  endMonth: string | null;
  rates: WorkforceRate[];
  splits: WorkforceSplit[];
  /** One per month of the workforce budget. */
  figures: MonthFigures[];
  total: { wages: string; kiwiSaver: string };
};

export type WorkforceTarget = {
  budgetId: string;
  name: string;
  trackingLabel: string | null;
  archived: boolean;
  /** Worked out: the fed amounts match today's figures (decision 117). */
  upToDate: boolean;
};

export type WorkforceDepartmentRow = { departmentId: string | null; label: string; wages: string[]; kiwiSaver: string[]; total: string };

export type WorkforceBudget = {
  id: string;
  name: string;
  firstMonth: string;
  months: string[];
  version: number;
  wagesAccount: { id: string; code: string; name: string };
  kiwiSaverAccount: { id: string; code: string; name: string };
  lines: WorkforceLine[];
  targets: WorkforceTarget[];
  departments: WorkforceDepartmentRow[];
  totals: { wages: string[]; kiwiSaver: string[]; total: string };
  createdByEmail: string;
  updatedByEmail: string;
  updatedAt: string;
};

export type WorkforceBudgetSummary = { id: string; name: string; firstMonth: string; months: number; lineCount: number; budgetNames: string[]; updatedAt: string };

type HeaderRow = {
  id: string;
  name: string;
  first_month: string;
  months: number;
  version: number;
  created_by_email: string;
  updated_by_email: string;
  updated_at: string;
  request_hash: string;
};

const HEADER = `select id::text, name, to_char(first_month, 'YYYY-MM') as first_month, months, version, created_by_email, updated_by_email, updated_at, request_hash
  from payroll_workforce_budgets`;

const FEED_SETTING = "tohyee.workforce_budget_feed";

function money(value: Decimal): string {
  return toFixedString(value, 2);
}

function parseName(input: unknown, what = "A workforce budget"): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new ValidationError(`${what} needs a name.`);
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length > WORKFORCE_LIMITS.nameLength) throw new ValidationError(`${what}'s name can be at most ${WORKFORCE_LIMITS.nameLength} characters.`);
  return name;
}

function parseMonthCount(input: unknown): number {
  const count = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > WORKFORCE_LIMITS.months) {
    throw new ValidationError(`A workforce budget covers 1 to ${WORKFORCE_LIMITS.months} months.`);
  }
  return count;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function findHeader(tx: OrgTx, id: string, lock = false): Promise<HeaderRow> {
  const found = await tx.query<HeaderRow>(`${HEADER} where id = $1${lock ? " for update" : ""}`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Workforce budget not found.");
  return found.rows[0];
}

function assertVersion(header: HeaderRow, version: unknown): void {
  if (version !== header.version) {
    throw new ConflictError("Someone else has changed this workforce budget since you opened it. Reload it to see their changes.");
  }
}

/** The system Ordinary time and KiwiSaver employer pay items' accounts (decision 119). */
async function payrollAccounts(tx: OrgTx): Promise<{ wages: WorkforceBudget["wagesAccount"]; kiwiSaver: WorkforceBudget["kiwiSaverAccount"] }> {
  const found = await tx.query<{ kind: string; id: string | null; code: string | null; name: string | null }>(
    `select p.kind, a.id::text, a.code, a.name from payroll_pay_items p left join accounts a on a.id = p.account_id
      where p.is_system and p.kind in ('ordinary_time', 'kiwisaver_employer')`,
  );
  const of = (kind: string, label: string) => {
    const row = found.rows.find((entry) => entry.kind === kind);
    if (!row?.id || !row.code || !row.name) throw new ValidationError(`The ${label} pay item has no account. Set one in Payroll › Pay items first.`);
    return { id: row.id, code: row.code, name: row.name };
  };
  return { wages: of("ordinary_time", "Ordinary time"), kiwiSaver: of("kiwisaver_employer", "KiwiSaver employer contribution") };
}

/** Workforce budgets, newest first (decision 122: payroll access). */
export async function listWorkforceBudgets(tx: OrgTx): Promise<WorkforceBudgetSummary[]> {
  await requirePayrollAccess(tx);
  const found = await tx.query<{ id: string; name: string; first_month: string; months: number; line_count: string; budget_names: string[] | null; updated_at: string }>(
    `select w.id::text, w.name, to_char(w.first_month, 'YYYY-MM') as first_month, w.months, w.updated_at,
            (select count(*) from payroll_workforce_budget_lines l where l.workforce_budget_id = w.id)::text as line_count,
            (select array_agg(b.name order by b.is_overall desc, lower(b.name)) from payroll_workforce_budget_targets t join budgets b on b.id = t.budget_id
              where t.workforce_budget_id = w.id) as budget_names
       from payroll_workforce_budgets w order by w.first_month desc, lower(w.name)`,
  );
  return found.rows.map((row) => ({
    id: row.id,
    name: row.name,
    firstMonth: row.first_month,
    months: row.months,
    lineCount: Number(row.line_count),
    budgetNames: row.budget_names ?? [],
    updatedAt: row.updated_at,
  }));
}

/** Starts a workforce budget: a name, a first month and 1-24 months (WB1). */
export async function createWorkforceBudget(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; workforceBudget: WorkforceBudget }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const name = parseName(input.name);
  const firstMonth = parseMonth(input.firstMonth, "The first month");
  const months = parseMonthCount(input.months);
  const hash = requestHash("payroll_workforce_budget_create", { name, firstMonth, months });
  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from payroll_workforce_budgets where idempotency_key = $1", [
    idempotencyKey,
  ]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "workforce budget");
    return { created: false, workforceBudget: await getWorkforceBudget(tx, earlier.rows[0].id) };
  }
  await payrollAccounts(tx);
  let id: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_workforce_budgets (idempotency_key, request_hash, name, first_month, months, created_by_user_id, created_by_email, updated_by_email)
       values ($1, $2, $3, $4::date, $5, $6, $7, $7) returning id::text`,
      [idempotencyKey, hash, name, monthStartDate(firstMonth), months, tx.actor.userId, tx.actor.email],
    );
    id = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a workforce budget called ${name}. Choose another name.`);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "payroll_workforce_budget.created", entityType: "payroll_workforce_budget", entityId: id, details: { firstMonth, months } });
  return { created: true, workforceBudget: await getWorkforceBudget(tx, id) };
}

type LineRow = {
  id: string;
  line_number: number;
  employee_id: string | null;
  employee_name: string | null;
  position_name: string | null;
  pay_basis: WorkforcePayBasis;
  fte: string | null;
  hours_per_week: string | null;
  kiwisaver_rate: string;
  start_month: string;
  end_month: string | null;
};

async function loadLines(tx: OrgTx, workforceBudgetId: string): Promise<Array<Omit<WorkforceLine, "figures" | "total">>> {
  const lines = await tx.query<LineRow>(
    `select l.id::text, l.line_number, l.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, l.position_name, l.pay_basis,
            l.fte::text, l.hours_per_week::text, l.kiwisaver_rate::text, to_char(l.start_month, 'YYYY-MM') as start_month,
            to_char(l.end_month, 'YYYY-MM') as end_month
       from payroll_workforce_budget_lines l left join payroll_employees e on e.id = l.employee_id
      where l.workforce_budget_id = $1 order by l.line_number`,
    [workforceBudgetId],
  );
  const ids = lines.rows.map((row) => row.id);
  const rates = await tx.query<{ line_id: string; from_month: string; rate: string }>(
    `select line_id::text, to_char(from_month, 'YYYY-MM') as from_month, rate::text from payroll_workforce_budget_line_rates
      where line_id = any($1::uuid[]) order by from_month`,
    [ids],
  );
  const splits = await tx.query<{ line_id: string; percentage: string; department_id: string | null; department_name: string | null; project_id: string | null; project_name: string | null }>(
    `select s.line_id::text, s.percentage::text, s.department_id::text, d.name as department_name, s.project_id::text, p.name as project_name
       from payroll_workforce_budget_line_splits s
       left join tracking_values d on d.id = s.department_id
       left join projects p on p.id = s.project_id
      where s.line_id = any($1::uuid[]) order by s.line_id, s.split_number`,
    [ids],
  );
  return lines.rows.map((row) => ({
    id: row.id,
    lineNumber: row.line_number,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    positionName: row.position_name,
    payBasis: row.pay_basis,
    fte: row.fte === null ? null : toPlainString(dec(row.fte)),
    hoursPerWeek: row.hours_per_week === null ? null : toPlainString(dec(row.hours_per_week)),
    kiwiSaverRate: toPlainString(dec(row.kiwisaver_rate)),
    startMonth: row.start_month,
    endMonth: row.end_month,
    rates: rates.rows
      .filter((rate) => rate.line_id === row.id)
      .map((rate) => ({ fromMonth: rate.from_month, rate: toFixedString(dec(rate.rate), row.pay_basis === "salary" ? 2 : 4).replace(/(\.\d\d)00$/, "$1") })),
    splits: splits.rows
      .filter((split) => split.line_id === row.id)
      .map((split) => ({
        percentage: toPlainString(dec(split.percentage)),
        departmentId: split.department_id,
        departmentName: split.department_name,
        projectId: split.project_id,
        projectName: split.project_name,
      })),
  }));
}

/** A split part of one line's month, with its tags (decision 117). */
type Part = {
  month: string;
  wages: string;
  kiwiSaver: string;
  departmentId: string | null;
  classId: string | null;
  locationId: string | null;
};

type Computed = { header: HeaderRow; months: string[]; lines: WorkforceLine[]; parts: Part[] };

async function compute(tx: OrgTx, header: HeaderRow): Promise<Computed> {
  const months = monthRange(header.first_month, header.months);
  const loaded = await loadLines(tx, header.id);
  const allocations = new Map<string, Awaited<ReturnType<typeof listAllocations>>>();
  for (const line of loaded) {
    if (line.employeeId && !allocations.has(line.employeeId)) allocations.set(line.employeeId, await listAllocations(tx, line.employeeId));
  }
  const parts: Part[] = [];
  const lines: WorkforceLine[] = loaded.map((line) => {
    const maths: WorkforceLineMaths = { ...line };
    const figures = lineFigures(maths, months);
    for (const month of figures) {
      if (isZero(dec(month.wages)) && isZero(dec(month.kiwiSaver))) continue;
      let shares: Array<{ percentage: string; departmentId: string | null; classId: string | null; locationId: string | null }>;
      if (line.employeeId) {
        const first = monthStartDate(month.month);
        // listAllocations is oldest first, so the last one starting on or before the 1st is in effect (PE6).
        const inEffect = (allocations.get(line.employeeId) ?? []).filter((allocation) => allocation.effectiveFrom <= first).at(-1);
        shares = inEffect
          ? inEffect.lines.map((entry) => ({ percentage: entry.percentage, departmentId: entry.departmentId, classId: entry.classId, locationId: entry.locationId }))
          : [{ percentage: "100", departmentId: null, classId: null, locationId: null }];
      } else {
        shares = line.splits.map((split) => ({ percentage: split.percentage, departmentId: split.departmentId, classId: null, locationId: null }));
      }
      const split = splitMonth(month, shares.map((share) => share.percentage));
      shares.forEach((share, index) => parts.push({ month: month.month, ...split[index], departmentId: share.departmentId, classId: share.classId, locationId: share.locationId }));
    }
    return {
      ...line,
      figures,
      total: { wages: addMoney(figures.map((month) => month.wages)), kiwiSaver: addMoney(figures.map((month) => month.kiwiSaver)) },
    };
  });
  return { header, months, lines, parts };
}

type TargetRow = { budget_id: string; name: string; archived: boolean; tracking_value_id: string | null; category_kind: string | null; tracking_label: string | null };

async function loadTargets(tx: OrgTx, workforceBudgetId: string): Promise<TargetRow[]> {
  const found = await tx.query<TargetRow>(
    `select b.id::text as budget_id, b.name, b.archived_at is not null as archived, b.tracking_value_id::text, c.kind as category_kind,
            case when v.id is null then null else c.name || ': ' || v.name end as tracking_label
       from payroll_workforce_budget_targets t
       join budgets b on b.id = t.budget_id
       left join tracking_values v on v.id = b.tracking_value_id
       left join tracking_categories c on c.id = v.category_id
      where t.workforce_budget_id = $1
      order by b.is_overall desc, lower(b.name)`,
    [workforceBudgetId],
  );
  return found.rows;
}

const PART_FIELD: Record<string, "departmentId" | "classId" | "locationId"> = { department: "departmentId", class: "classId", location: "locationId" };

/** The wages and KiwiSaver amounts a workforce budget writes into one budget (decisions 120-121). */
async function amountsFor(tx: OrgTx, computed: Computed, target: TargetRow, accounts: Awaited<ReturnType<typeof payrollAccounts>>): Promise<WorkforceAmount[]> {
  let keep: (part: Part) => boolean = () => true;
  if (target.tracking_value_id) {
    const field = target.category_kind ? PART_FIELD[target.category_kind] : undefined;
    const values = new Set(await valueWithDescendants(tx, target.tracking_value_id));
    keep = field ? (part) => part[field] !== null && values.has(part[field]!) : () => false;
  }
  const cells = new Map<string, Decimal>();
  for (const month of computed.months) {
    cells.set(`${accounts.wages.id}|${month}`, ZERO_DECIMAL);
    cells.set(`${accounts.kiwiSaver.id}|${month}`, ZERO_DECIMAL);
  }
  for (const part of computed.parts) {
    if (!keep(part)) continue;
    const wagesKey = `${accounts.wages.id}|${part.month}`;
    cells.set(wagesKey, add(cells.get(wagesKey)!, dec(part.wages)));
    const kiwiSaverKey = `${accounts.kiwiSaver.id}|${part.month}`;
    cells.set(kiwiSaverKey, add(cells.get(kiwiSaverKey)!, dec(part.kiwiSaver)));
  }
  const codes = new Map([
    [accounts.wages.id, accounts.wages.code],
    [accounts.kiwiSaver.id, accounts.kiwiSaver.code],
  ]);
  return [...cells.entries()].map(([key, amount]) => {
    const [accountId, month] = key.split("|");
    return { accountId, accountCode: codes.get(accountId)!, month, amount: money(amount) };
  });
}

async function isUpToDate(tx: OrgTx, workforceBudgetId: string, budgetId: string, wanted: readonly WorkforceAmount[]): Promise<boolean> {
  const owned = await workforceOwnedAmounts(tx, budgetId, workforceBudgetId);
  if (owned.size !== wanted.length) return false;
  return wanted.every((amount) => {
    const stored = owned.get(`${amount.accountId}|${amount.month}`);
    return stored !== undefined && cmp(stored, dec(amount.amount)) === 0;
  });
}

/** Rewrites the fed budgets from today's figures (decisions 113, 117); archived ones are skipped. */
async function feedBudgets(tx: OrgTx, computed: Computed, released: readonly string[] = []): Promise<number> {
  const accounts = await payrollAccounts(tx);
  await tx.query("select set_config($1, $2, true)", [FEED_SETTING, computed.header.id]);
  let changed = 0;
  try {
    for (const budgetId of released) changed += await writeWorkforceAmounts(tx, budgetId, computed.header.id, computed.header.name, []);
    for (const target of await loadTargets(tx, computed.header.id)) {
      if (target.archived) continue;
      changed += await writeWorkforceAmounts(tx, target.budget_id, computed.header.id, computed.header.name, await amountsFor(tx, computed, target, accounts));
    }
  } finally {
    await tx.query("select set_config($1, '', true)", [FEED_SETTING]);
  }
  return changed;
}

/** A workforce budget with each line's monthly figures, totals by Department and its fed budgets (WB1-WB3). */
export async function getWorkforceBudget(tx: OrgTx, idInput: unknown): Promise<WorkforceBudget> {
  await requirePayrollAccess(tx);
  const header = await findHeader(tx, requireUuid(idInput, "workforceBudgetId"));
  const accounts = await payrollAccounts(tx);
  const computed = await compute(tx, header);
  const targets: WorkforceTarget[] = [];
  for (const target of await loadTargets(tx, header.id)) {
    const wanted = await amountsFor(tx, computed, target, accounts);
    targets.push({
      budgetId: target.budget_id,
      name: target.name,
      trackingLabel: target.tracking_label,
      archived: target.archived,
      upToDate: await isUpToDate(tx, header.id, target.budget_id, wanted),
    });
  }
  const departmentNames = await departmentLabels(tx, computed.parts.map((part) => part.departmentId));
  const byDepartment = new Map<string, { departmentId: string | null; wages: Decimal[]; kiwiSaver: Decimal[] }>();
  const index = new Map(computed.months.map((month, position) => [month, position]));
  const wagesTotals = computed.months.map(() => ZERO_DECIMAL);
  const kiwiSaverTotals = computed.months.map(() => ZERO_DECIMAL);
  for (const part of computed.parts) {
    const key = part.departmentId ?? "";
    const row = byDepartment.get(key) ?? { departmentId: part.departmentId, wages: computed.months.map(() => ZERO_DECIMAL), kiwiSaver: computed.months.map(() => ZERO_DECIMAL) };
    const position = index.get(part.month)!;
    row.wages[position] = add(row.wages[position], dec(part.wages));
    row.kiwiSaver[position] = add(row.kiwiSaver[position], dec(part.kiwiSaver));
    wagesTotals[position] = add(wagesTotals[position], dec(part.wages));
    kiwiSaverTotals[position] = add(kiwiSaverTotals[position], dec(part.kiwiSaver));
    byDepartment.set(key, row);
  }
  const departments = [...byDepartment.values()]
    .map((row) => ({
      departmentId: row.departmentId,
      label: row.departmentId ? (departmentNames.get(row.departmentId) ?? "Department") : "No Department",
      wages: row.wages.map(money),
      kiwiSaver: row.kiwiSaver.map(money),
      total: money([...row.wages, ...row.kiwiSaver].reduce(add, ZERO_DECIMAL)),
    }))
    .sort((a, b) => (a.departmentId === null ? 1 : 0) - (b.departmentId === null ? 1 : 0) || a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
  return {
    id: header.id,
    name: header.name,
    firstMonth: header.first_month,
    months: computed.months,
    version: header.version,
    wagesAccount: accounts.wages,
    kiwiSaverAccount: accounts.kiwiSaver,
    lines: computed.lines,
    targets,
    departments,
    totals: {
      wages: wagesTotals.map(money),
      kiwiSaver: kiwiSaverTotals.map(money),
      total: money([...wagesTotals, ...kiwiSaverTotals].reduce(add, ZERO_DECIMAL)),
    },
    createdByEmail: header.created_by_email,
    updatedByEmail: header.updated_by_email,
    updatedAt: header.updated_at,
  };
}

async function departmentLabels(tx: OrgTx, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const found = await tx.query<{ id: string; name: string }>("select id::text, name from tracking_values where id = any($1::bigint[])", [wanted]);
  return new Map(found.rows.map((row) => [row.id, row.name]));
}

async function checkTarget(tx: OrgTx, workforceBudgetId: string, budgetId: string): Promise<void> {
  const budget = await getBudgetSummary(tx, budgetId);
  if (budget.archivedAt) throw new ValidationError(`${budget.name} is archived. Bring it back before a workforce budget feeds it.`);
  if (budget.trackingValueId) {
    const kind = await tx.query<{ kind: string }>("select c.kind from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1", [
      budget.trackingValueId,
    ]);
    if (!PART_FIELD[kind.rows[0]?.kind ?? ""]) {
      throw new ValidationError(`${budget.name} is for ${budget.trackingLabel}. Payroll is split by Department, Class and Location only, so a workforce budget can't feed it.`);
    }
  }
  const other = await tx.query<{ name: string }>(
    `select w.name from payroll_workforce_budget_targets t join payroll_workforce_budgets w on w.id = t.workforce_budget_id
      where t.budget_id = $1 and t.workforce_budget_id <> $2`,
    [budgetId, workforceBudgetId],
  );
  if (other.rows[0]) throw new ConflictError(`${budget.name} is already fed by the workforce budget ${other.rows[0].name}. A budget is fed by one workforce budget.`);
}

/**
 * Changes the name, months or the budgets it feeds (WB2, WB4), against the
 * version loaded, then rewrites the fed budgets. A budget taken off keeps
 * its amounts as ordinary typed amounts.
 */
export async function updateWorkforceBudget(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<WorkforceBudget> {
  await requirePayrollAccess(tx);
  const id = requireUuid(idInput, "workforceBudgetId");
  const header = await findHeader(tx, id, true);
  assertVersion(header, input.version);
  const name = input.name === undefined ? header.name : parseName(input.name);
  const firstMonth = input.firstMonth === undefined ? header.first_month : parseMonth(input.firstMonth, "The first month");
  const months = input.months === undefined ? header.months : parseMonthCount(input.months);
  const lastMonth = addMonths(firstMonth, months - 1);
  const outside = await tx.query<{ line_number: number }>(
    `select line_number from payroll_workforce_budget_lines
      where workforce_budget_id = $1 and (start_month < $2::date or start_month > $3::date or end_month > $3::date) order by line_number limit 1`,
    [id, monthStartDate(firstMonth), monthStartDate(lastMonth)],
  );
  if (outside.rows[0]) throw new ValidationError(`Line ${outside.rows[0].line_number} is outside ${firstMonth} to ${lastMonth}. Change its months first.`);
  const current = (await loadTargets(tx, id)).map((target) => target.budget_id);
  let released: string[] = [];
  if (input.budgetIds !== undefined) {
    const wanted = [...new Set(requireArray(input.budgetIds, "budgetIds", 200).map((entry) => requireId(entry, "budgetId")))];
    for (const budgetId of wanted.filter((entry) => !current.includes(entry))) await checkTarget(tx, id, budgetId);
    released = current.filter((entry) => !wanted.includes(entry));
    for (const budgetId of released) {
      const budget = await getBudgetSummary(tx, budgetId);
      if (budget.archivedAt) throw new ValidationError(`${budget.name} is archived. Bring it back before taking it off, so its amounts can be released.`);
    }
    await tx.query("delete from payroll_workforce_budget_targets where workforce_budget_id = $1 and budget_id = any($2::bigint[])", [id, released]);
    for (const budgetId of wanted.filter((entry) => !current.includes(entry))) {
      try {
        await tx.query("insert into payroll_workforce_budget_targets (workforce_budget_id, budget_id, added_by_email) values ($1, $2, $3)", [id, budgetId, tx.actor.email]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError("That budget is already fed by another workforce budget.");
        throw error;
      }
    }
  }
  try {
    await tx.query(
      `update payroll_workforce_budgets set name = $2, first_month = $3::date, months = $4, version = version + 1, updated_by_email = $5, updated_at = now() where id = $1`,
      [id, name, monthStartDate(firstMonth), months, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a workforce budget called ${name}. Choose another name.`);
    throw error;
  }
  const updated = await findHeader(tx, id);
  await feedBudgets(tx, await compute(tx, updated), released);
  await writeAuditEvent(tx, {
    eventType: "payroll_workforce_budget.changed",
    entityType: "payroll_workforce_budget",
    entityId: id,
    details: { firstMonth, months, budgetIds: (await loadTargets(tx, id)).map((target) => target.budget_id), releasedBudgetIds: released },
  });
  return getWorkforceBudget(tx, id);
}

type ParsedLine = {
  employeeId: string | null;
  positionName: string | null;
  payBasis: WorkforcePayBasis;
  fte: string | null;
  hoursPerWeek: string | null;
  kiwiSaverRate: string;
  startMonth: string;
  endMonth: string | null;
  rates: WorkforceRate[];
  splits: Array<{ percentage: string; departmentId: string | null; projectId: string | null }>;
};

function optionalMonth(input: unknown, what: string): string | null {
  return input == null || input === "" ? null : parseMonth(input, what);
}

function parseRate(input: unknown, basis: WorkforcePayBasis, what: string): string {
  return parseDecimalInput(input, what, { maxScale: basis === "salary" ? 2 : 4 });
}

/** Defaults from the employee's records (decision 116) for anything not typed. */
async function parseLine(tx: OrgTx, raw: unknown, number: number, firstMonth: string, lastMonth: string): Promise<ParsedLine> {
  const item = asRecord(raw, `Line ${number}`);
  const label = `Line ${number}`;
  const employeeId = item.employeeId == null || item.employeeId === "" ? null : requireUuid(item.employeeId, "employeeId");
  let positionName: string | null = null;
  let defaults: { payBasis: WorkforcePayBasis; rate: string | null; hours: string | null; kiwiSaverRate: string; startMonth: string; endMonth: string | null } | null = null;
  if (employeeId) {
    const employee = await tx.query<{ is_archived: boolean; start_month: string; finish_month: string | null; kiwisaver_status: string; kiwisaver_employer_rate: string }>(
      `select is_archived, to_char(start_date, 'YYYY-MM') as start_month, to_char(finish_date, 'YYYY-MM') as finish_month, kiwisaver_status,
              kiwisaver_employer_rate::text
         from payroll_employees where id = $1`,
      [employeeId],
    );
    const row = employee.rows[0];
    if (!row) throw new ValidationError(`${label}: there's no such employee.`);
    if (row.is_archived) throw new ValidationError(`${label}: the employee is archived.`);
    const startMonth = row.start_month > firstMonth ? row.start_month : firstMonth;
    const pay = (await payRateOn(tx, employeeId, monthStartDate(startMonth))) ?? (await firstPayRate(tx, employeeId));
    defaults = {
      payBasis: pay?.payBasis ?? "salary",
      rate: pay ? (pay.payBasis === "salary" ? pay.annualSalary : pay.hourlyRate) : null,
      hours: pay?.ordinaryHoursPerWeek ?? null,
      kiwiSaverRate: row.kiwisaver_status === "enrolled" ? toPlainString(dec(row.kiwisaver_employer_rate)) : "0",
      startMonth,
      endMonth: row.finish_month && row.finish_month <= lastMonth ? row.finish_month : null,
    };
  } else {
    positionName = parseName(item.positionName, `${label}'s position`);
  }
  const payBasis = (item.payBasis ?? defaults?.payBasis) as WorkforcePayBasis;
  if (payBasis !== "salary" && payBasis !== "hourly") throw new ValidationError(`${label}: choose salary or hourly.`);
  const startMonth = optionalMonth(item.startMonth, `${label}'s start month`) ?? defaults?.startMonth ?? firstMonth;
  const endMonth = item.endMonth === undefined ? (defaults?.endMonth ?? null) : optionalMonth(item.endMonth, `${label}'s end month`);
  if (startMonth < firstMonth || startMonth > lastMonth) throw new ValidationError(`${label} starts outside the workforce budget's months (${firstMonth} to ${lastMonth}).`);
  if (endMonth !== null && (endMonth < startMonth || endMonth > lastMonth)) {
    throw new ValidationError(`${label} must end on or after its start month and by ${lastMonth}.`);
  }
  let fte: string | null = null;
  let hoursPerWeek: string | null = null;
  if (payBasis === "salary") {
    fte = parseDecimalInput(item.fte == null || item.fte === "" ? "1" : item.fte, `${label}'s FTE`, { maxScale: 4 });
    if (cmp(dec(fte), dec("1")) > 0) throw new ValidationError(`${label}'s FTE can be at most 1.`);
  } else {
    const hours = item.hoursPerWeek == null || item.hoursPerWeek === "" ? defaults?.hours : item.hoursPerWeek;
    if (hours == null) throw new ValidationError(`${label} is hourly, so it needs hours a week.`);
    hoursPerWeek = parseDecimalInput(hours, `${label}'s hours a week`, { maxScale: 2 });
    if (cmp(dec(hoursPerWeek), dec("168")) > 0) throw new ValidationError(`${label}'s hours a week can be at most 168.`);
  }
  const kiwiSaverRate = parseDecimalInput(item.kiwiSaverRate == null || item.kiwiSaverRate === "" ? (defaults?.kiwiSaverRate ?? "0") : item.kiwiSaverRate, `${label}'s KiwiSaver rate`, {
    maxScale: 2,
    allowZero: true,
  });
  if (cmp(dec(kiwiSaverRate), dec("100")) > 0) throw new ValidationError(`${label}'s KiwiSaver rate can be at most 100%.`);
  let rates: WorkforceRate[];
  if (item.rates == null || (Array.isArray(item.rates) && item.rates.length === 0)) {
    if (!defaults?.rate || (defaults.payBasis !== payBasis)) throw new ValidationError(`${label} needs a ${payBasis === "salary" ? "salary" : "hourly rate"}.`);
    rates = [{ fromMonth: startMonth, rate: parseRate(defaults.rate, payBasis, `${label}'s pay`) }];
  } else {
    rates = requireArray(item.rates, "rates", WORKFORCE_LIMITS.rises).map((entry, index) => {
      const rate = asRecord(entry, `${label}'s pay ${index + 1}`);
      return {
        fromMonth: index === 0 && (rate.fromMonth == null || rate.fromMonth === "") ? startMonth : parseMonth(rate.fromMonth, `${label}'s pay rise month`),
        rate: parseRate(rate.rate, payBasis, `${label}'s ${payBasis === "salary" ? "salary" : "hourly rate"}`),
      };
    });
  }
  rates.sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
  if (rates[0].fromMonth !== startMonth) throw new ValidationError(`${label}'s first pay must be from its start month, ${startMonth}.`);
  for (const [index, rate] of rates.entries()) {
    if (index > 0 && rate.fromMonth === rates[index - 1].fromMonth) throw new ValidationError(`${label} has two pays from ${rate.fromMonth}.`);
    if (rate.fromMonth > (endMonth ?? lastMonth)) throw new ValidationError(`${label}'s pay rise in ${rate.fromMonth} is after the line ends.`);
  }
  let splits: ParsedLine["splits"] = [];
  if (!employeeId) {
    splits = requireArray(item.splits, "splits", WORKFORCE_LIMITS.splitLines).map((entry, index) => {
      const split = asRecord(entry, `${label}'s split ${index + 1}`);
      return {
        percentage: parseAllocationPercentage(split.percentage, `${label}'s split ${index + 1}`),
        departmentId: optionalId(split.departmentId, "departmentId"),
        projectId: optionalId(split.projectId, "projectId"),
      };
    });
    if (splits.length === 0) throw new ValidationError(`${label} is a position, so it needs a split by Department (100% to one is fine).`);
    try {
      assertTotalsOneHundred(splits.map((split) => split.percentage));
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(`${label}: ${error.message}`);
      throw error;
    }
    for (const split of splits) {
      if (split.departmentId) {
        const found = await tx.query("select 1 from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1 and c.kind = 'department'", [
          split.departmentId,
        ]);
        if (!found.rows[0]) throw new ValidationError(`${label}: there's no such Department.`);
      }
      if (split.projectId) {
        const found = await tx.query("select 1 from projects where id = $1", [split.projectId]);
        if (!found.rows[0]) throw new ValidationError(`${label}: there's no such project.`);
      }
    }
  }
  return { employeeId, positionName, payBasis, fte, hoursPerWeek, kiwiSaverRate, startMonth, endMonth, rates, splits };
}

/**
 * Replaces the lines (WB1, WB3, WB7) against the version loaded and
 * rewrites the fed budgets. An employee line may give only `employeeId`;
 * its pay, KiwiSaver rate and months come from the employee's records.
 */
export async function saveWorkforceLines(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<WorkforceBudget> {
  await requirePayrollAccess(tx);
  const id = requireUuid(idInput, "workforceBudgetId");
  const header = await findHeader(tx, id, true);
  assertVersion(header, input.version);
  const lastMonth = addMonths(header.first_month, header.months - 1);
  const raw = requireArray(input.lines, "lines", WORKFORCE_LIMITS.lines);
  const lines: ParsedLine[] = [];
  for (const [index, entry] of raw.entries()) lines.push(await parseLine(tx, entry, index + 1, header.first_month, lastMonth));
  const employees = lines.map((line) => line.employeeId).filter((employee): employee is string => employee !== null);
  if (new Set(employees).size !== employees.length) throw new ValidationError("An employee can only have one line. Use pay rises for changes in pay.");
  await tx.query("delete from payroll_workforce_budget_lines where workforce_budget_id = $1", [id]);
  for (const [index, line] of lines.entries()) {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_workforce_budget_lines
         (workforce_budget_id, line_number, employee_id, position_name, pay_basis, fte, hours_per_week, kiwisaver_rate, start_month, end_month)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date) returning id::text`,
      [
        id,
        index + 1,
        line.employeeId,
        line.positionName,
        line.payBasis,
        line.fte,
        line.hoursPerWeek,
        line.kiwiSaverRate,
        monthStartDate(line.startMonth),
        line.endMonth ? monthStartDate(line.endMonth) : null,
      ],
    );
    for (const rate of line.rates) {
      await tx.query("insert into payroll_workforce_budget_line_rates (line_id, from_month, rate) values ($1, $2::date, $3)", [
        inserted.rows[0].id,
        monthStartDate(rate.fromMonth),
        rate.rate,
      ]);
    }
    for (const [splitIndex, split] of line.splits.entries()) {
      await tx.query("insert into payroll_workforce_budget_line_splits (line_id, split_number, percentage, department_id, project_id) values ($1, $2, $3, $4, $5)", [
        inserted.rows[0].id,
        splitIndex + 1,
        split.percentage,
        split.departmentId,
        split.projectId,
      ]);
    }
  }
  await tx.query("update payroll_workforce_budgets set version = version + 1, updated_by_email = $2, updated_at = now() where id = $1", [id, tx.actor.email]);
  await feedBudgets(tx, await compute(tx, await findHeader(tx, id)));
  await writeAuditEvent(tx, {
    eventType: "payroll_workforce_budget.lines_saved",
    entityType: "payroll_workforce_budget",
    entityId: id,
    details: { lineCount: lines.length, employeeLines: employees.length, positionLines: lines.length - employees.length },
  });
  return getWorkforceBudget(tx, id);
}

/** "Update budgets": rewrites the fed budgets from today's figures, e.g. after an allocation changed (WB3). */
export async function updateFedBudgets(tx: OrgTx, idInput: unknown): Promise<{ changed: number; workforceBudget: WorkforceBudget }> {
  await requirePayrollAccess(tx);
  const id = requireUuid(idInput, "workforceBudgetId");
  const header = await findHeader(tx, id, true);
  const changed = await feedBudgets(tx, await compute(tx, header));
  await writeAuditEvent(tx, { eventType: "payroll_workforce_budget.budgets_updated", entityType: "payroll_workforce_budget", entityId: id, details: { changed } });
  return { changed, workforceBudget: await getWorkforceBudget(tx, id) };
}

export type WorkforceVsActualRow = { departmentId: string | null; label: string; budget: string; actual: string; variance: string };
export type WorkforceVsActualMonth = { month: string; rows: WorkforceVsActualRow[]; total: { budget: string; actual: string; variance: string } };

/**
 * Budget vs actual for wages (WB5, decision 123): per month and
 * Department, the workforce budget's wages and KiwiSaver against P10's
 * labour cost by pay date.
 */
export async function workforceBudgetVsActual(tx: OrgTx, idInput: unknown): Promise<{ months: WorkforceVsActualMonth[] }> {
  const budget = await getWorkforceBudget(tx, idInput);
  const result: WorkforceVsActualMonth[] = [];
  for (const [position, month] of budget.months.entries()) {
    const actual = await labourCostReport(tx, { from: monthStartDate(month), to: monthEndDate(month), groupBy: "department" });
    const rows = new Map<string, WorkforceVsActualRow>();
    for (const row of budget.departments) {
      const amount = add(dec(row.wages[position]), dec(row.kiwiSaver[position]));
      rows.set(row.departmentId ?? "", { departmentId: row.departmentId, label: row.label, budget: money(amount), actual: "0.00", variance: "0.00" });
    }
    for (const group of actual.groups) {
      const key = group.key ?? "";
      const existing = rows.get(key) ?? { departmentId: group.key, label: group.label, budget: "0.00", actual: "0.00", variance: "0.00" };
      existing.actual = group.total;
      rows.set(key, existing);
    }
    const list = [...rows.values()]
      .filter((row) => !(isZero(dec(row.budget)) && isZero(dec(row.actual))))
      .map((row) => ({ ...row, variance: money(sub(dec(row.actual), dec(row.budget))) }))
      .sort((a, b) => (a.departmentId === null ? 1 : 0) - (b.departmentId === null ? 1 : 0) || a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
    const totalBudget = addMoney(list.map((row) => row.budget));
    const totalActual = addMoney(list.map((row) => row.actual));
    result.push({ month, rows: list, total: { budget: totalBudget, actual: totalActual, variance: money(sub(dec(totalActual), dec(totalBudget))) } });
  }
  return { months: result };
}
