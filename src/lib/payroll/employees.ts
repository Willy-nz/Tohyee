import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { primaryDepartments } from "@/lib/payroll/allocations";
import { checkGroupForEmployee, PAY_FREQUENCIES, PAY_FREQUENCY_WORDS } from "@/lib/payroll/groups";
import { KIWI_SAVER_STATUSES } from "@/lib/payroll/pay-calculation";
import { currentPay, firstPayRate, insertStartingPayRate, PAY_BASES, type PayDetails, parsePayDetails } from "@/lib/payroll/pay-rates";
import { PAYROLL_RATE_EDITIONS } from "@/lib/payroll/rates";
import { decryptSecret, encryptSecret, keyedSecretHash } from "@/lib/secrets";
import { optionalString, requireBoolean, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/** Every ESCT rate in IRD's bands (spec 5.21); a pay run checks it against the pay date's bands. */
const ESCT_RATES = [
  ...new Set(PAYROLL_RATE_EDITIONS.flatMap((edition) => edition.esct.flatMap((dated) => dated.value.map((band) => band.rate)))),
].sort((a, b) => cmp(dec(a), dec(b)));
const PAY_FIELDS = ["payBasis", "annualSalary", "hourlyRate", "ordinaryHoursPerWeek"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Employee = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  postalAddress: string | null;
  dateOfBirth: string | null;
  taxCode: string;
  irdNumber: string;
  kiwiSaverStatus: (typeof KIWI_SAVER_STATUSES)[number];
  kiwiSaverEmployeeRate: string;
  kiwiSaverEmployerRate: string;
  /** For employer KiwiSaver contributions (spec 5.21); null until it's set (PRUN8). */
  esctRate: string | null;
  studentLoan: boolean;
  payFrequency: (typeof PAY_FREQUENCIES)[number];
  payBasis: (typeof PAY_BASES)[number];
  annualSalary: string | null;
  hourlyRate: string | null;
  ordinaryHoursPerWeek: string | null;
  startDate: string;
  finishDate: string | null;
  bankAccount: string | null;
  isArchived: boolean;
  jobTitle: string | null;
  reportsToId: string | null;
  reportsToName: string | null;
  payGroupId: string | null;
  payGroupName: string | null;
  employeeGroupId: string | null;
  employeeGroupName: string | null;
  /** The Department on the biggest line of the cost allocation in effect today (PE6). */
  primaryDepartment: { id: string; name: string } | null;
};

export type EmployeeSummary = Omit<Employee, "irdNumber" | "bankAccount"> & {
  hasIrdNumber: boolean;
  hasBankAccount: boolean;
};

type EmployeeRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  postal_address: string | null;
  date_of_birth: string | null;
  tax_code: string;
  ird_number_ciphertext: string;
  kiwisaver_status: (typeof KIWI_SAVER_STATUSES)[number];
  kiwisaver_employee_rate: string;
  kiwisaver_employer_rate: string;
  esct_rate: string | null;
  student_loan: boolean;
  pay_frequency: (typeof PAY_FREQUENCIES)[number];
  pay_basis: (typeof PAY_BASES)[number];
  annual_salary: string | null;
  hourly_rate: string | null;
  ordinary_hours_per_week: string | null;
  start_date: string;
  finish_date: string | null;
  bank_account_ciphertext: string | null;
  is_archived: boolean;
  job_title: string | null;
  reports_to_id: string | null;
  pay_group_id: string | null;
  employee_group_id: string | null;
  idempotency_key: string;
  request_hash: string;
};

/** What an employee's details show beside their row: current pay, names and primary department. */
type Extras = {
  pay: Map<string, PayDetails>;
  names: Map<string, { reports_to_name: string | null; pay_group_name: string | null; employee_group_name: string | null }>;
  departments: Map<string, { id: string; name: string } | null>;
};

const EMPLOYEE_COLUMNS = `
  id, first_name, last_name, email, phone, postal_address, date_of_birth::text,
  tax_code, ird_number_ciphertext, kiwisaver_status, kiwisaver_employee_rate::text,
  kiwisaver_employer_rate::text, esct_rate::text, student_loan, pay_frequency, pay_basis,
  annual_salary::text, hourly_rate::text, ordinary_hours_per_week::text,
  start_date::text, finish_date::text, bank_account_ciphertext, is_archived,
  job_title, reports_to_id, pay_group_id, employee_group_id,
  idempotency_key, request_hash`;

type ParsedEmployee = Omit<EmployeeRow, "id" | "idempotency_key" | "request_hash">;

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) throw new ValidationError(`${field} wasn't found.`);
  return value.trim().toLowerCase();
}

function decimalField(value: unknown, field: string, maxScale: number, allowZero: boolean): string {
  if (value === undefined || value === null || value === "") throw new ValidationError(`${field} is required.`);
  return parseDecimalInput(value, field, { maxScale, allowZero });
}

function parseRate(value: unknown, field: string): string {
  const rate = decimalField(value, field, 2, true);
  if (cmp(dec(rate), dec("100")) > 0) throw new ValidationError(`${field} can't be more than 100%.`);
  return rate;
}

function parseIrdNumber(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("IRD number must be text.");
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{8,9}$/.test(digits)) throw new ValidationError("IRD number must have 8 or 9 digits.");
  return digits;
}

function currentValue(input: Record<string, unknown>, field: string, current: unknown): unknown {
  return input[field] === undefined ? current : input[field];
}

function parseEmployee(input: Record<string, unknown>, current?: EmployeeRow): ParsedEmployee {
  const firstName = requireString(currentValue(input, "firstName", current?.first_name), "First name", { maxLength: 100 });
  const lastName = requireString(currentValue(input, "lastName", current?.last_name), "Last name", { maxLength: 100 });
  const email = optionalString(currentValue(input, "email", current?.email), "Email", { maxLength: 320 });
  const phone = optionalString(currentValue(input, "phone", current?.phone), "Phone", { maxLength: 50 });
  const postalAddress = optionalString(currentValue(input, "postalAddress", current?.postal_address), "Postal address", {
    maxLength: 1000,
  });
  const dateOfBirth = parseOptionalIsoDate(currentValue(input, "dateOfBirth", current?.date_of_birth), "Date of birth");
  const taxCode = requireString(currentValue(input, "taxCode", current?.tax_code), "Tax code", {
    maxLength: 20,
    pattern: /^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*$/,
    patternHint: "Tax code must use letters and numbers, with spaces between parts.",
  }).replace(/\s+/g, " ").toUpperCase();
  const kiwiSaverStatus = requireOneOf(
    currentValue(input, "kiwiSaverStatus", current?.kiwisaver_status),
    "KiwiSaver status",
    KIWI_SAVER_STATUSES,
  );
  const kiwiSaverEmployeeRate = parseRate(
    currentValue(input, "kiwiSaverEmployeeRate", current?.kiwisaver_employee_rate),
    "KiwiSaver employee rate",
  );
  const kiwiSaverEmployerRate = parseRate(
    currentValue(input, "kiwiSaverEmployerRate", current?.kiwisaver_employer_rate),
    "KiwiSaver employer rate",
  );
  const esctInput = currentValue(input, "esctRate", current?.esct_rate);
  let esctRate: string | null = null;
  if (esctInput !== undefined && esctInput !== null && esctInput !== "") {
    const rate = parseRate(esctInput, "ESCT rate");
    if (!ESCT_RATES.some((entry) => cmp(dec(entry), dec(rate)) === 0)) {
      throw new ValidationError(`ESCT rate must be one of IRD's: ${ESCT_RATES.map((entry) => `${entry}%`).join(", ")}.`);
    }
    esctRate = rate;
  }
  const studentLoan = requireBoolean(currentValue(input, "studentLoan", current?.student_loan), "Student loan");
  const payFrequency = requireOneOf(currentValue(input, "payFrequency", current?.pay_frequency), "Pay frequency", PAY_FREQUENCIES);
  // Pay is set once here, as the starting pay; after that it changes under Pay rates, with a date (PE7).
  if (current && PAY_FIELDS.some((field) => input[field] !== undefined)) {
    throw new ValidationError("Change pay under Pay rates, with the date the new rate starts.");
  }
  const pay: PayDetails = current
    ? {
        payBasis: current.pay_basis,
        annualSalary: current.annual_salary,
        hourlyRate: current.hourly_rate,
        ordinaryHoursPerWeek: current.ordinary_hours_per_week,
      }
    : parsePayDetails(input);
  const jobTitle = optionalString(currentValue(input, "jobTitle", current?.job_title), "Job title", { maxLength: 100 });
  const reportsToId = optionalUuid(currentValue(input, "reportsToId", current?.reports_to_id) ?? null, "The manager");
  const payGroupId = optionalUuid(currentValue(input, "payGroupId", current?.pay_group_id) ?? null, "That pay group");
  const employeeGroupId = optionalUuid(currentValue(input, "employeeGroupId", current?.employee_group_id) ?? null, "That employee group");
  const startDate = parseIsoDate(currentValue(input, "startDate", current?.start_date), "Start date");
  const finishDate = parseOptionalIsoDate(currentValue(input, "finishDate", current?.finish_date), "Finish date");
  if (finishDate && finishDate < startDate) throw new ValidationError("Finish date can't be before the start date.");

  let irdNumberCiphertext = current?.ird_number_ciphertext ?? "";
  if (input.irdNumber !== undefined) irdNumberCiphertext = encryptSecret(parseIrdNumber(input.irdNumber));
  if (!irdNumberCiphertext) throw new ValidationError("IRD number is required.");

  let bankAccountCiphertext = current?.bank_account_ciphertext ?? null;
  if (input.bankAccount !== undefined) {
    const bankAccount = optionalString(input.bankAccount, "Bank account", { maxLength: 80 });
    bankAccountCiphertext = bankAccount === null ? null : encryptSecret(bankAccount);
  }

  return {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    postal_address: postalAddress,
    date_of_birth: dateOfBirth,
    tax_code: taxCode,
    ird_number_ciphertext: irdNumberCiphertext,
    kiwisaver_status: kiwiSaverStatus,
    kiwisaver_employee_rate: kiwiSaverEmployeeRate,
    kiwisaver_employer_rate: kiwiSaverEmployerRate,
    esct_rate: esctRate,
    student_loan: studentLoan,
    pay_frequency: payFrequency,
    pay_basis: pay.payBasis,
    annual_salary: pay.annualSalary,
    hourly_rate: pay.hourlyRate,
    ordinary_hours_per_week: pay.ordinaryHoursPerWeek,
    start_date: startDate,
    finish_date: finishDate,
    bank_account_ciphertext: bankAccountCiphertext,
    is_archived: current?.is_archived ?? false,
    job_title: jobTitle,
    reports_to_id: reportsToId,
    pay_group_id: payGroupId,
    employee_group_id: employeeGroupId,
  };
}

function plain(value: string | null): string | null {
  return value === null ? null : toPlainString(dec(value));
}

function toEmployeeWithoutSecrets(row: EmployeeRow, extras: Extras): Omit<Employee, "irdNumber" | "bankAccount"> {
  // Pay comes from the rate history (PE7); the row keeps the starting pay.
  const pay = extras.pay.get(row.id) ?? {
    payBasis: row.pay_basis,
    annualSalary: row.annual_salary,
    hourlyRate: row.hourly_rate,
    ordinaryHoursPerWeek: row.ordinary_hours_per_week,
  };
  const names = extras.names.get(row.id);
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    postalAddress: row.postal_address,
    dateOfBirth: row.date_of_birth,
    taxCode: row.tax_code,
    kiwiSaverStatus: row.kiwisaver_status,
    kiwiSaverEmployeeRate: toPlainString(dec(row.kiwisaver_employee_rate)),
    kiwiSaverEmployerRate: toPlainString(dec(row.kiwisaver_employer_rate)),
    esctRate: plain(row.esct_rate),
    studentLoan: row.student_loan,
    payFrequency: row.pay_frequency,
    payBasis: pay.payBasis,
    annualSalary: plain(pay.annualSalary),
    hourlyRate: plain(pay.hourlyRate),
    ordinaryHoursPerWeek: plain(pay.ordinaryHoursPerWeek),
    startDate: row.start_date,
    finishDate: row.finish_date,
    isArchived: row.is_archived,
    jobTitle: row.job_title,
    reportsToId: row.reports_to_id,
    reportsToName: names?.reports_to_name ?? null,
    payGroupId: row.pay_group_id,
    payGroupName: names?.pay_group_name ?? null,
    employeeGroupId: row.employee_group_id,
    employeeGroupName: names?.employee_group_name ?? null,
    primaryDepartment: extras.departments.get(row.id) ?? null,
  };
}

function toEmployee(row: EmployeeRow, extras: Extras): Employee {
  return {
    ...toEmployeeWithoutSecrets(row, extras),
    irdNumber: decryptSecret(row.ird_number_ciphertext),
    bankAccount: row.bank_account_ciphertext === null ? null : decryptSecret(row.bank_account_ciphertext),
  };
}

function toSummary(row: EmployeeRow, extras: Extras): EmployeeSummary {
  return {
    ...toEmployeeWithoutSecrets(row, extras),
    hasIrdNumber: Boolean(row.ird_number_ciphertext),
    hasBankAccount: Boolean(row.bank_account_ciphertext),
  };
}

async function loadExtras(tx: OrgTx, rows: readonly EmployeeRow[]): Promise<Extras> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { pay: new Map(), names: new Map(), departments: new Map() };
  const names = await tx.query<{
    id: string;
    reports_to_name: string | null;
    pay_group_name: string | null;
    employee_group_name: string | null;
  }>(
    `select e.id, m.first_name || ' ' || m.last_name as reports_to_name, pg.name as pay_group_name, eg.name as employee_group_name
       from payroll_employees e
       left join payroll_employees m on m.id = e.reports_to_id
       left join payroll_pay_groups pg on pg.id = e.pay_group_id
       left join payroll_employee_groups eg on eg.id = e.employee_group_id
      where e.id = any($1::uuid[])`,
    [ids],
  );
  return {
    pay: await currentPay(tx, ids),
    names: new Map(names.rows.map((row) => [row.id, row])),
    departments: await primaryDepartments(tx, ids),
  };
}

async function decorate(tx: OrgTx, row: EmployeeRow): Promise<Employee> {
  return toEmployee(row, await loadExtras(tx, [row]));
}

async function findEmployee(tx: OrgTx, id: string, forUpdate = false): Promise<EmployeeRow> {
  const result = await tx.query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from payroll_employees where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundError("Employee not found.");
  return result.rows[0];
}

export async function getEmployee(tx: OrgTx, id: string): Promise<Employee> {
  await requirePayrollAccess(tx);
  return decorate(tx, await findEmployee(tx, id));
}

export async function listEmployees(
  tx: OrgTx,
  options: { includeArchived?: boolean } = {},
): Promise<EmployeeSummary[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from payroll_employees
      where ($1::boolean or not is_archived)
      order by lower(last_name), lower(first_name), id`,
    [options.includeArchived ?? false],
  );
  const extras = await loadExtras(tx, result.rows);
  return result.rows.map((row) => toSummary(row, extras));
}

export async function createEmployee(
  tx: OrgTx,
  input: Record<string, unknown> & { idempotencyKey?: unknown },
): Promise<{ created: boolean; employee: Employee }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = keyedSecretHash(requestHash("payroll_employee", input));
  const earlier = await tx.query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from payroll_employees where idempotency_key = $1`,
    [idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "employee");
    return { created: false, employee: await decorate(tx, earlier.rows[0]) };
  }

  const parsed = parseEmployee(input);
  await checkJobDetails(tx, null, parsed);
  const inserted = await tx.query<EmployeeRow>(
    `insert into payroll_employees (
       idempotency_key, request_hash, first_name, last_name, email, phone, postal_address, date_of_birth,
       tax_code, ird_number_ciphertext, kiwisaver_status, kiwisaver_employee_rate, kiwisaver_employer_rate,
       student_loan, pay_frequency, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       start_date, finish_date, bank_account_ciphertext, job_title, reports_to_id, pay_group_id, employee_group_id,
       esct_rate
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26, $27
     )
     on conflict (idempotency_key) do nothing
     returning ${EMPLOYEE_COLUMNS}`,
    [
      idempotencyKey,
      hash,
      parsed.first_name,
      parsed.last_name,
      parsed.email,
      parsed.phone,
      parsed.postal_address,
      parsed.date_of_birth,
      parsed.tax_code,
      parsed.ird_number_ciphertext,
      parsed.kiwisaver_status,
      parsed.kiwisaver_employee_rate,
      parsed.kiwisaver_employer_rate,
      parsed.student_loan,
      parsed.pay_frequency,
      parsed.pay_basis,
      parsed.annual_salary,
      parsed.hourly_rate,
      parsed.ordinary_hours_per_week,
      parsed.start_date,
      parsed.finish_date,
      parsed.bank_account_ciphertext,
      parsed.job_title,
      parsed.reports_to_id,
      parsed.pay_group_id,
      parsed.employee_group_id,
      parsed.esct_rate,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    const winner = await tx.query<EmployeeRow>(
      `select ${EMPLOYEE_COLUMNS} from payroll_employees where idempotency_key = $1`,
      [idempotencyKey],
    );
    if (winner.rows[0]) {
      assertSameRequest(winner.rows[0].request_hash, hash, "employee");
      return { created: false, employee: await decorate(tx, winner.rows[0]) };
    }
    throw new ConflictError("The employee couldn't be saved. Try again with a new idempotency key.");
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_employee.created",
    entityType: "payroll_employee",
    entityId: row.id,
    details: { payFrequency: row.pay_frequency, payBasis: row.pay_basis },
  });
  await insertStartingPayRate(tx, row.id, row.start_date, {
    payBasis: row.pay_basis,
    annualSalary: row.annual_salary,
    hourlyRate: row.hourly_rate,
    ordinaryHoursPerWeek: row.ordinary_hours_per_week,
  });
  return { created: true, employee: await decorate(tx, row) };
}

export async function updateEmployee(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<Employee> {
  await requirePayrollAccess(tx);
  if (input.reportsToId !== undefined) {
    // Two people changing who reports to whom at once could make a loop; take turns.
    await tx.query("lock table payroll_employees in share row exclusive mode");
  }
  const current = await findEmployee(tx, id, true);
  const parsed = parseEmployee(input, current);
  await checkJobDetails(tx, current, parsed);
  if (parsed.start_date !== current.start_date) await checkStartDate(tx, id, parsed.start_date);
  const changedFields = Object.keys(input).filter((field) => field !== "source");
  const result = await tx.query<EmployeeRow>(
    `update payroll_employees set
       first_name = $2, last_name = $3, email = $4, phone = $5, postal_address = $6, date_of_birth = $7,
       tax_code = $8, ird_number_ciphertext = $9, kiwisaver_status = $10, kiwisaver_employee_rate = $11,
       kiwisaver_employer_rate = $12, student_loan = $13, pay_frequency = $14, start_date = $15,
       finish_date = $16, bank_account_ciphertext = $17, job_title = $18, reports_to_id = $19,
       pay_group_id = $20, employee_group_id = $21, esct_rate = $22, updated_at = now()
     where id = $1
     returning ${EMPLOYEE_COLUMNS}`,
    [
      id,
      parsed.first_name,
      parsed.last_name,
      parsed.email,
      parsed.phone,
      parsed.postal_address,
      parsed.date_of_birth,
      parsed.tax_code,
      parsed.ird_number_ciphertext,
      parsed.kiwisaver_status,
      parsed.kiwisaver_employee_rate,
      parsed.kiwisaver_employer_rate,
      parsed.student_loan,
      parsed.pay_frequency,
      parsed.start_date,
      parsed.finish_date,
      parsed.bank_account_ciphertext,
      parsed.job_title,
      parsed.reports_to_id,
      parsed.pay_group_id,
      parsed.employee_group_id,
      parsed.esct_rate,
    ],
  );
  const row = result.rows[0];
  if (row.start_date !== current.start_date) {
    // Their pay from the new start date is their first rate (PE7).
    const first = await firstPayRate(tx, id);
    if (first && row.start_date < first.effectiveFrom) {
      await insertStartingPayRate(tx, id, row.start_date, first, `starting-pay:${id}:${row.start_date}`);
    }
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_employee.updated",
    entityType: "payroll_employee",
    entityId: id,
    details: { changedFields },
  });
  return decorate(tx, row);
}

export async function setEmployeeArchived(tx: OrgTx, id: string, isArchived: boolean): Promise<Employee> {
  await requirePayrollAccess(tx);
  const current = await findEmployee(tx, id, true);
  if (current.is_archived === isArchived) return decorate(tx, current);
  const result = await tx.query<EmployeeRow>(
    `update payroll_employees set is_archived = $2, updated_at = now()
      where id = $1 returning ${EMPLOYEE_COLUMNS}`,
    [id, isArchived],
  );
  await writeAuditEvent(tx, {
    eventType: isArchived ? "payroll_employee.archived" : "payroll_employee.unarchived",
    entityType: "payroll_employee",
    entityId: id,
  });
  return decorate(tx, result.rows[0]);
}

/**
 * Reports-to, pay group and employee group (PE8): the manager is another
 * employee, never themselves or someone who reports to them; a pay group's
 * frequency must be the employee's. Archived managers and groups can be kept
 * but not newly chosen.
 */
async function checkJobDetails(tx: OrgTx, current: EmployeeRow | null, parsed: ParsedEmployee): Promise<void> {
  if (parsed.reports_to_id !== null && parsed.reports_to_id !== current?.reports_to_id) {
    if (current && parsed.reports_to_id === current.id) throw new ValidationError(`${parsed.first_name} can't report to themselves.`);
    const manager = await tx.query<{ first_name: string; last_name: string; is_archived: boolean }>(
      "select first_name, last_name, is_archived from payroll_employees where id = $1",
      [parsed.reports_to_id],
    );
    const found = manager.rows[0];
    if (!found) throw new ValidationError("The manager wasn't found.");
    const managerName = `${found.first_name} ${found.last_name}`;
    if (found.is_archived) throw new ValidationError(`${managerName} is archived.`);
    if (current) {
      const loop = await tx.query(
        `with recursive chain(id) as (
           select reports_to_id from payroll_employees where id = $1
           union
           select e.reports_to_id from payroll_employees e join chain on e.id = chain.id where e.reports_to_id is not null
         )
         select 1 from chain where id = $2 limit 1`,
        [parsed.reports_to_id, current.id],
      );
      if (loop.rows[0]) {
        throw new ValidationError(`${parsed.first_name} can't report to ${managerName}, because ${managerName} reports to them (directly or further up).`);
      }
    }
  }
  if (parsed.pay_group_id !== null) {
    const group = await checkGroupForEmployee(tx, "pay", parsed.pay_group_id, current?.pay_group_id ?? null);
    if (group.payFrequency !== parsed.pay_frequency) {
      throw new ValidationError(
        `${parsed.first_name} is paid ${PAY_FREQUENCY_WORDS[parsed.pay_frequency]} but ${group.name} is ${PAY_FREQUENCY_WORDS[group.payFrequency!]}.`,
      );
    }
  }
  if (parsed.employee_group_id !== null) {
    await checkGroupForEmployee(tx, "employee", parsed.employee_group_id, current?.employee_group_id ?? null);
  }
}

/** Pay rates and cost allocations can't start before the employee does (PE6, PE7). */
async function checkStartDate(tx: OrgTx, id: string, startDate: string): Promise<void> {
  const earliest = await tx.query<{ effective_from: string }>(
    `select min(effective_from)::text as effective_from from (
       select effective_from from payroll_pay_rates
        where employee_id = $1 and request_hash not in ('starting-pay', 'migration-0057')
       union all
       select effective_from from payroll_cost_allocations where employee_id = $1
     ) dates`,
    [id],
  );
  const first = earliest.rows[0]?.effective_from;
  if (first && startDate > first) {
    throw new ValidationError(`The start date can't be after ${first}, when a pay rate or cost allocation already starts.`);
  }
}
