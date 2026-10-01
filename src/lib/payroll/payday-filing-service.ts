import { createHash } from "node:crypto";
import packageJson from "../../../package.json";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requirePayrollAccess } from "@/lib/payroll/access";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
  makeEmploymentInformationFile,
  parseContactEmail,
  parseContactName,
  parseContactPhone,
  parseEmployerIrdNumber,
  paydayFilingDueDate,
  type PaydayFilingFile,
} from "@/lib/payroll/payday-filing";
import { payRunReference, type PayRunStatus } from "@/lib/payroll/pay-runs";
import { decryptSecret } from "@/lib/secrets";

/**
 * Payday filing (examples PF1-PF9, decisions 56-65): the employment
 * information file for an approved pay run, its due date, and the header
 * details it needs (payroll settings). Making a file posts nothing and
 * records only an audit event with the file's hash; employees' IRD numbers
 * are decrypted only here, after the payroll access check, and never logged.
 */

/** HEI2 field 27: the spec's "Vendor_Package_v1.0" shape, no employer information (decision 62). */
export const PAYROLL_PACKAGE_IDENTIFIER = `Tohyee_Tohyee_v${packageJson.version}`;

export const PAYDAY_FILING_SETUP_MESSAGE =
  "Set up payday filing first: an admin enters the employer's IRD number and the payroll contact under Payroll › Pay items.";

export type PaydayFilingSettings = {
  /** 9 digits, or null until it's set. */
  employerIrdNumber: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** All four are set, so a file can be made. */
  complete: boolean;
};

type SettingsRow = {
  payroll_employer_ird_number: string | null;
  payroll_contact_name: string | null;
  payroll_contact_phone: string | null;
  payroll_contact_email: string | null;
};

async function readSettings(tx: OrgTx): Promise<PaydayFilingSettings> {
  const result = await tx.query<SettingsRow>(
    `select payroll_employer_ird_number, payroll_contact_name, payroll_contact_phone, payroll_contact_email
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  const settings = {
    employerIrdNumber: row?.payroll_employer_ird_number ?? null,
    contactName: row?.payroll_contact_name ?? null,
    contactPhone: row?.payroll_contact_phone ?? null,
    contactEmail: row?.payroll_contact_email ?? null,
  };
  return { ...settings, complete: Object.values(settings).every((value) => value !== null) };
}

/** Payday filing settings (PF7). Payroll access. */
export async function getPaydayFilingSettings(tx: OrgTx): Promise<PaydayFilingSettings> {
  await requirePayrollAccess(tx);
  return readSettings(tx);
}

/**
 * Saves the payday filing settings (PF7, decision 62): all four together,
 * checked against IRD's field rules. Admins with payroll access; the route
 * checks the role.
 */
export async function updatePaydayFilingSettings(
  tx: OrgTx,
  input: { employerIrdNumber?: unknown; contactName?: unknown; contactPhone?: unknown; contactEmail?: unknown },
): Promise<PaydayFilingSettings> {
  await requirePayrollAccess(tx);
  const employerIrdNumber = parseEmployerIrdNumber(input.employerIrdNumber);
  const contactName = parseContactName(input.contactName);
  const contactPhone = parseContactPhone(input.contactPhone);
  const contactEmail = parseContactEmail(input.contactEmail);
  const updated = await tx.query(
    `update organisation_settings
        set payroll_employer_ird_number = $1, payroll_contact_name = $2, payroll_contact_phone = $3, payroll_contact_email = $4
      where id = true`,
    [employerIrdNumber, contactName, contactPhone, contactEmail],
  );
  if (updated.rowCount !== 1) throw new NotFoundError("The organisation's settings weren't found.");
  await writeAuditEvent(tx, {
    eventType: "payroll_payday_filing_settings.updated",
    entityType: "organisation_settings",
    entityId: "payroll",
    details: { contactName, contactEmail },
  });
  return readSettings(tx);
}

type RunRow = {
  id: string;
  run_number: string;
  status: PayRunStatus;
  pay_date: string;
  period_start: string;
  period_end: string;
  pay_frequency: PayFrequency;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findRun(tx: OrgTx, idInput: unknown): Promise<RunRow> {
  if (typeof idInput !== "string" || !UUID_PATTERN.test(idInput)) throw new NotFoundError("That pay run wasn't found.");
  const result = await tx.query<RunRow>(
    `select id, run_number::text, status, pay_date::text, period_start::text, period_end::text, pay_frequency
       from payroll_pay_runs where id = $1`,
    [idInput],
  );
  if (!result.rows[0]) throw new NotFoundError("That pay run wasn't found.");
  return result.rows[0];
}

type EmployeeRow = {
  employee_id: string;
  employee_name: string | null;
  name_now: string;
  tax_code: string | null;
  start_date: string;
  finish_date: string | null;
  ird_number_ciphertext: string;
  hours: string;
  taxable_earnings: string | null;
  paye: string | null;
  student_loan_deduction: string | null;
  kiwisaver_employee: string | null;
  kiwisaver_employer_net: string | null;
  esct: string | null;
  not_liable_for_acc_levy: string;
  lump_sum_lowest_rate: boolean | null;
};

/** The pay run's employees in its own order (last name, first name), with the figures kept when it was approved. */
async function loadEmployees(tx: OrgTx, runId: string): Promise<EmployeeRow[]> {
  const result = await tx.query<EmployeeRow>(
    `select pe.employee_id, pe.employee_name, e.first_name || ' ' || e.last_name as name_now, pe.tax_code,
            e.start_date::text, coalesce(pe.finish_date, e.finish_date)::text as finish_date, e.ird_number_ciphertext,
            (select coalesce(sum(l.quantity), 0)::text
               from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
              where l.pay_run_id = pe.pay_run_id and l.employee_id = pe.employee_id
                and p.category = 'earnings' and l.quantity is not null) as hours,
            pe.taxable_earnings::text, pe.paye::text, pe.student_loan_deduction::text, pe.kiwisaver_employee::text,
            pe.kiwisaver_employer_net::text, pe.esct::text,
            (select coalesce(sum(l.amount), 0)::text
               from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
              where l.pay_run_id = pe.pay_run_id and l.employee_id = pe.employee_id
                and p.subject_to_paye and not p.subject_to_acc_levy) as not_liable_for_acc_levy,
            pe.lump_sum_lowest_rate
       from payroll_pay_run_employees pe
       join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1
      order by lower(e.last_name), lower(e.first_name), pe.employee_id`,
    [runId],
  );
  return result.rows;
}

export type PayRunPaydayFiling = {
  payRunId: string;
  reference: string;
  status: PayRunStatus;
  payDate: string;
  /** Pay date + 2 working days, weekends skipped, public holidays not (PF6). */
  dueDate: string;
  employeeCount: number;
  settingsComplete: boolean;
  /** Employees whose start date is in the pay period: their details go to IRD in myIR (PF5, decision 64). */
  starting: Array<{ employeeId: string; name: string; startDate: string }>;
};

/** What the pay run's payday filing card shows (PF5, PF6). Payroll access. */
export async function getPayRunPaydayFiling(tx: OrgTx, runIdInput: unknown): Promise<PayRunPaydayFiling> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput);
  const employees = await loadEmployees(tx, run.id);
  const settings = await readSettings(tx);
  return {
    payRunId: run.id,
    reference: payRunReference(run.run_number),
    status: run.status,
    payDate: run.pay_date,
    dueDate: paydayFilingDueDate(run.pay_date),
    employeeCount: employees.length,
    settingsComplete: settings.complete,
    starting: employees
      .filter((row) => row.start_date >= run.period_start && row.start_date <= run.period_end)
      .map((row) => ({ employeeId: row.employee_id, name: row.employee_name ?? row.name_now, startDate: row.start_date })),
  };
}

export type PayRunPaydayFilingFile = PaydayFilingFile & { payRunReference: string; payDate: string; dueDate: string; sha256: string };

/**
 * Makes the employment information file for an approved pay run (PF1-PF5,
 * PF7, PF8). Posts nothing; writes one audit event with the file's name,
 * number of lines and SHA-256, never an amount or IRD number.
 */
export async function makePayRunPaydayFilingFile(tx: OrgTx, runIdInput: unknown): Promise<PayRunPaydayFilingFile> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput);
  const reference = payRunReference(run.run_number);
  if (run.status === "draft") throw new ConflictError(`${reference} is a draft, so it has no employment information file. Approve it first.`);
  if (run.status === "voided") {
    throw new ConflictError(`${reference} is voided, so it has no employment information file. If you filed it, amend it in myIR.`);
  }
  const settings = await readSettings(tx);
  if (!settings.complete) throw new ValidationError(PAYDAY_FILING_SETUP_MESSAGE);

  const employees = await loadEmployees(tx, run.id);
  const file = makeEmploymentInformationFile({
    header: {
      employerIrdNumber: settings.employerIrdNumber!,
      payDate: run.pay_date,
      contactName: settings.contactName!,
      contactPhone: settings.contactPhone!,
      contactEmail: settings.contactEmail!,
      packageIdentifier: PAYROLL_PACKAGE_IDENTIFIER,
    },
    employees: employees.map((row) => {
      if (row.taxable_earnings === null || row.paye === null) {
        throw new ConflictError(`${reference} has no stored figures for ${row.employee_name ?? row.name_now}. Void it and run the pay again.`);
      }
      return {
        irdNumber: decryptSecret(row.ird_number_ciphertext),
        name: row.employee_name ?? row.name_now,
        taxCode: row.tax_code ?? "",
        startDate: row.start_date,
        finishDate: row.finish_date,
        periodStart: run.period_start,
        periodEnd: run.period_end,
        payFrequency: run.pay_frequency,
        hours: row.hours,
        grossEarnings: row.taxable_earnings,
        paye: row.paye,
        studentLoan: row.student_loan_deduction ?? "0",
        kiwiSaverDeductions: row.kiwisaver_employee ?? "0",
        kiwiSaverEmployerNet: row.kiwisaver_employer_net ?? "0",
        esct: row.esct ?? "0",
        notLiableForAccLevy: row.not_liable_for_acc_levy,
        lumpSumLowestRate: row.lump_sum_lowest_rate ?? false,
      };
    }),
    fileStem: reference,
  });
  const sha256 = createHash("sha256").update(file.content, "utf8").digest("hex");
  await writeAuditEvent(tx, {
    eventType: "payroll_payday_filing.made",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { payRunReference: reference, fileName: file.fileName, employeeLines: file.employeeLines, sha256 },
  });
  return { ...file, payRunReference: reference, payDate: run.pay_date, dueDate: paydayFilingDueDate(run.pay_date), sha256 };
}
