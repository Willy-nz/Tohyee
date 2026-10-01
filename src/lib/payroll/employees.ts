import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { decryptSecret, encryptSecret, keyedSecretHash } from "@/lib/secrets";
import { optionalString, requireBoolean, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

const KIWI_SAVER_STATUSES = ["enrolled", "not_enrolled", "opted_out", "savings_suspension", "not_eligible"] as const;
const PAY_FREQUENCIES = ["weekly", "fortnightly", "four_weekly", "monthly"] as const;
const PAY_BASES = ["salary", "hourly"] as const;

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
  idempotency_key: string;
  request_hash: string;
};

const EMPLOYEE_COLUMNS = `
  id, first_name, last_name, email, phone, postal_address, date_of_birth::text,
  tax_code, ird_number_ciphertext, kiwisaver_status, kiwisaver_employee_rate::text,
  kiwisaver_employer_rate::text, student_loan, pay_frequency, pay_basis,
  annual_salary::text, hourly_rate::text, ordinary_hours_per_week::text,
  start_date::text, finish_date::text, bank_account_ciphertext, is_archived,
  idempotency_key, request_hash`;

type ParsedEmployee = Omit<EmployeeRow, "id" | "idempotency_key" | "request_hash">;

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
  const studentLoan = requireBoolean(currentValue(input, "studentLoan", current?.student_loan), "Student loan");
  const payFrequency = requireOneOf(currentValue(input, "payFrequency", current?.pay_frequency), "Pay frequency", PAY_FREQUENCIES);
  const payBasis = requireOneOf(currentValue(input, "payBasis", current?.pay_basis), "Pay basis", PAY_BASES);
  const annualSalary =
    payBasis === "salary"
      ? decimalField(currentValue(input, "annualSalary", current?.annual_salary), "Annual salary", 2, false)
      : null;
  const hourlyRate =
    payBasis === "hourly" ? decimalField(currentValue(input, "hourlyRate", current?.hourly_rate), "Hourly rate", 2, false) : null;
  const ordinaryHoursPerWeek =
    payBasis === "hourly"
      ? decimalField(currentValue(input, "ordinaryHoursPerWeek", current?.ordinary_hours_per_week), "Ordinary hours per week", 2, false)
      : null;
  for (const [field, value] of [
    ["Annual salary", annualSalary],
    ["Hourly rate", hourlyRate],
  ] as const) {
    if (value !== null && cmp(dec(value), dec("99999999999999.99")) > 0) throw new ValidationError(`${field} is too large.`);
  }
  if (ordinaryHoursPerWeek && cmp(dec(ordinaryHoursPerWeek), dec("99999.99")) > 0) {
    throw new ValidationError("Ordinary hours per week is too large.");
  }
  if (payBasis === "salary" && (input.hourlyRate != null || input.ordinaryHoursPerWeek != null)) {
    throw new ValidationError("Salary employees can't also have an hourly rate or ordinary hours.");
  }
  if (payBasis === "hourly" && input.annualSalary != null) {
    throw new ValidationError("Hourly employees can't also have an annual salary.");
  }
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
    student_loan: studentLoan,
    pay_frequency: payFrequency,
    pay_basis: payBasis,
    annual_salary: annualSalary,
    hourly_rate: hourlyRate,
    ordinary_hours_per_week: ordinaryHoursPerWeek,
    start_date: startDate,
    finish_date: finishDate,
    bank_account_ciphertext: bankAccountCiphertext,
    is_archived: current?.is_archived ?? false,
  };
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    postalAddress: row.postal_address,
    dateOfBirth: row.date_of_birth,
    taxCode: row.tax_code,
    irdNumber: decryptSecret(row.ird_number_ciphertext),
    kiwiSaverStatus: row.kiwisaver_status,
    kiwiSaverEmployeeRate: toPlainString(dec(row.kiwisaver_employee_rate)),
    kiwiSaverEmployerRate: toPlainString(dec(row.kiwisaver_employer_rate)),
    studentLoan: row.student_loan,
    payFrequency: row.pay_frequency,
    payBasis: row.pay_basis,
    annualSalary: row.annual_salary === null ? null : toPlainString(dec(row.annual_salary)),
    hourlyRate: row.hourly_rate === null ? null : toPlainString(dec(row.hourly_rate)),
    ordinaryHoursPerWeek: row.ordinary_hours_per_week === null ? null : toPlainString(dec(row.ordinary_hours_per_week)),
    startDate: row.start_date,
    finishDate: row.finish_date,
    bankAccount: row.bank_account_ciphertext === null ? null : decryptSecret(row.bank_account_ciphertext),
    isArchived: row.is_archived,
  };
}

function toSummary(row: EmployeeRow): EmployeeSummary {
  return {
    ...toEmployeeWithoutSecrets(row),
    hasIrdNumber: Boolean(row.ird_number_ciphertext),
    hasBankAccount: Boolean(row.bank_account_ciphertext),
  };
}

function toEmployeeWithoutSecrets(row: EmployeeRow): Omit<Employee, "irdNumber" | "bankAccount"> {
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
    studentLoan: row.student_loan,
    payFrequency: row.pay_frequency,
    payBasis: row.pay_basis,
    annualSalary: row.annual_salary === null ? null : toPlainString(dec(row.annual_salary)),
    hourlyRate: row.hourly_rate === null ? null : toPlainString(dec(row.hourly_rate)),
    ordinaryHoursPerWeek: row.ordinary_hours_per_week === null ? null : toPlainString(dec(row.ordinary_hours_per_week)),
    startDate: row.start_date,
    finishDate: row.finish_date,
    isArchived: row.is_archived,
  };
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
  return toEmployee(await findEmployee(tx, id));
}

export async function listEmployees(
  tx: OrgTx,
  options: { includeArchived?: boolean } = {},
): Promise<EmployeeSummary[]> {
  const result = await tx.query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from payroll_employees
      where ($1::boolean or not is_archived)
      order by lower(last_name), lower(first_name), id`,
    [options.includeArchived ?? false],
  );
  return result.rows.map(toSummary);
}

export async function createEmployee(
  tx: OrgTx,
  input: Record<string, unknown> & { idempotencyKey?: unknown },
): Promise<{ created: boolean; employee: Employee }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = keyedSecretHash(requestHash("payroll_employee", input));
  const earlier = await tx.query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from payroll_employees where idempotency_key = $1`,
    [idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "employee");
    return { created: false, employee: toEmployee(earlier.rows[0]) };
  }

  const parsed = parseEmployee(input);
  const inserted = await tx.query<EmployeeRow>(
    `insert into payroll_employees (
       idempotency_key, request_hash, first_name, last_name, email, phone, postal_address, date_of_birth,
       tax_code, ird_number_ciphertext, kiwisaver_status, kiwisaver_employee_rate, kiwisaver_employer_rate,
       student_loan, pay_frequency, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       start_date, finish_date, bank_account_ciphertext
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
      return { created: false, employee: toEmployee(winner.rows[0]) };
    }
    throw new ConflictError("The employee couldn't be saved. Try again with a new idempotency key.");
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_employee.created",
    entityType: "payroll_employee",
    entityId: row.id,
    details: { payFrequency: row.pay_frequency, payBasis: row.pay_basis },
  });
  return { created: true, employee: toEmployee(row) };
}

export async function updateEmployee(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<Employee> {
  const current = await findEmployee(tx, id, true);
  const parsed = parseEmployee(input, current);
  const changedFields = Object.keys(input).filter((field) => field !== "source");
  const result = await tx.query<EmployeeRow>(
    `update payroll_employees set
       first_name = $2, last_name = $3, email = $4, phone = $5, postal_address = $6, date_of_birth = $7,
       tax_code = $8, ird_number_ciphertext = $9, kiwisaver_status = $10, kiwisaver_employee_rate = $11,
       kiwisaver_employer_rate = $12, student_loan = $13, pay_frequency = $14, pay_basis = $15,
       annual_salary = $16, hourly_rate = $17, ordinary_hours_per_week = $18, start_date = $19,
       finish_date = $20, bank_account_ciphertext = $21, updated_at = now()
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
      parsed.pay_basis,
      parsed.annual_salary,
      parsed.hourly_rate,
      parsed.ordinary_hours_per_week,
      parsed.start_date,
      parsed.finish_date,
      parsed.bank_account_ciphertext,
    ],
  );
  const row = result.rows[0];
  await writeAuditEvent(tx, {
    eventType: "payroll_employee.updated",
    entityType: "payroll_employee",
    entityId: id,
    details: { changedFields },
  });
  return toEmployee(row);
}

export async function setEmployeeArchived(tx: OrgTx, id: string, isArchived: boolean): Promise<Employee> {
  const current = await findEmployee(tx, id, true);
  if (current.is_archived === isArchived) return toEmployee(current);
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
  return toEmployee(result.rows[0]);
}
