import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { add, dec, type Decimal, isNegative, significantScale, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { PayFrequency } from "./groups";

/**
 * IRD's payday filing "employment information" (EI) file for one approved
 * pay run (examples PF1-PF9, decisions 56-65). Pure: no database, no
 * network.
 *
 * Source: IRD, Payday Filing File Upload Specification 2026-27 ("version
 * 2027", July 2026), section 3.4: one HEI2 header record (28 fields) and a
 * DEI record per employee (27 fields), comma separated. Summarised in
 * docs/sources/ird-payday-filing-file-spec.md. Amounts and hours are
 * written in hundredths with no decimal point (the spec's example file and
 * its "37.5 hours = 3750"); dates are CCYYMMDD.
 */

/** Spec field 9 (DEI), "Employee Pay cycle". */
export const PAY_CYCLE_CODES: Record<PayFrequency, string> = {
  weekly: "WK",
  fortnightly: "FT",
  four_weekly: "4W",
  monthly: "MT",
};

/** HEI2 field 28. */
const IR_FORM_VERSION = "0001";

export type PaydayFilingHeader = {
  /** 8 or 9 digits. */
  employerIrdNumber: string;
  payDate: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** HEI2 field 27, e.g. "Tohyee_Tohyee_v0.3.1". */
  packageIdentifier: string;
};

export type PaydayFilingEmployee = {
  /** 8 or 9 digits. */
  irdNumber: string;
  name: string;
  taxCode: string;
  startDate: string | null;
  finishDate: string | null;
  periodStart: string;
  periodEnd: string;
  payFrequency: PayFrequency;
  /** Hours paid, up to 2 decimal places. */
  hours: string;
  /** Taxable gross earnings (spec field 11). */
  grossEarnings: string;
  paye: string;
  studentLoan: string;
  kiwiSaverDeductions: string;
  /** Employer KiwiSaver contributions net of ESCT. */
  kiwiSaverEmployerNet: string;
  esct: string;
  /** Taxable earnings not liable for the ACC earners' levy (field 13): redundancy (decision 129). */
  notLiableForAccLevy?: string;
  /** An extra pay taxed at the lowest rate (field 14; spec 5.11.3, decision 129). */
  lumpSumLowestRate?: boolean;
};

export type PaydayFilingTotals = {
  grossEarnings: string;
  paye: string;
  studentLoan: string;
  kiwiSaverDeductions: string;
  kiwiSaverEmployerNet: string;
  esct: string;
  /** HEI2 field 23. */
  amountsDeducted: string;
};

export type PaydayFilingFile = {
  fileName: string;
  contentType: string;
  content: string;
  employeeLines: number;
  totals: PaydayFilingTotals;
};

/** CCYYMMDD. */
function dateField(date: string, label: string): string {
  return parseIsoDate(date, label).replaceAll("-", "");
}

/**
 * An amount or hours in hundredths with no decimal point and no padding:
 * 2692.31 → "269231", 36 → "3600", 0 → "0" (decision 57).
 */
export function hundredths(value: string, label: string): string {
  const amount = dec(value);
  if (isNegative(amount)) throw new ValidationError(`${label} can't be below zero in the employment information file.`);
  if (significantScale(amount) > 2) throw new ValidationError(`${label} has more than 2 decimal places.`);
  const digits = toFixedString(amount, 2).replace(".", "").replace(/^0+(?=\d)/, "");
  return digits;
}

/** An IRD number of 8 or 9 digits as the file's 9 (a leading 0 for 8 digits, decision 60). */
export function irdNumberField(value: string, label: string): string {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{8,9}$/.test(digits)) throw new ValidationError(`${label} must have 8 or 9 digits.`);
  const padded = digits.padStart(9, "0");
  if (padded === "000000000") throw new ValidationError(`${label} can't be all zeros.`);
  return padded;
}

/** An employee's name with commas replaced by spaces and spaces collapsed (decision 60). */
export function nameField(name: string): string {
  const cleaned = name.replaceAll(",", " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") throw new ValidationError("An employee on this pay run has no name.");
  if ([...cleaned].length > 255) throw new ValidationError(`${cleaned.slice(0, 40)}…'s name is longer than IRD's 255 characters.`);
  return cleaned;
}

// Payday filing settings (decision 62)

/** The employer's IRD number for the header: 8 or 9 digits, kept as 9. */
export function parseEmployerIrdNumber(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Enter the employer's IRD number.");
  if (!/^[\d\s-]+$/.test(input.trim())) throw new ValidationError("The employer's IRD number must have 8 or 9 digits, like 123-456-789.");
  return irdNumberField(input, "The employer's IRD number");
}

/** HEI2 field 7: up to 20 characters, no commas. */
export function parseContactName(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Enter the payroll contact's name.");
  const name = input.trim().replace(/\s+/g, " ");
  if (name.includes(",")) throw new ValidationError("The payroll contact's name can't have a comma (IRD's rule).");
  if ([...name].length > 20) throw new ValidationError("The payroll contact's name can be up to 20 characters (IRD's rule), like \"Mere Tipene\".");
  return name;
}

/** HEI2 field 8: a work phone of up to 12 letters and digits; spaces, dashes, brackets, dots and a leading + are dropped. */
export function parseContactPhone(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Enter the payroll contact's work phone number.");
  const phone = input.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  if (!/^[0-9A-Za-z]{1,12}$/.test(phone)) {
    throw new ValidationError("The payroll contact's work phone can be up to 12 digits (IRD's rule), like 03 477 1234.");
  }
  return phone;
}

/** HEI2 field 9: up to 60 of A-Z a-z 0-9 @ - _ . , with "@domain" and no ".." (IRD's rules). */
export function parseContactEmail(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Enter the payroll contact's email address.");
  const email = input.trim();
  if (email.length > 60) throw new ValidationError("The payroll contact's email can be up to 60 characters (IRD's rule).");
  if (!/^[A-Za-z0-9@\-_.]+$/.test(email)) {
    throw new ValidationError("The payroll contact's email can only use letters, digits and @ - _ . (IRD's rule).");
  }
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email) || email.includes("..")) {
    throw new ValidationError("Enter the payroll contact's email address, like payroll@example.co.nz.");
  }
  return email;
}

// Due date (decision 63)

function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * When the EI is due: "within 2 working days of each payday" for electronic
 * filers (IRD, Payday filing; spec 3.4). Saturdays and Sundays are skipped;
 * public holidays aren't (Tohyee has no list yet), so this is never later
 * than IRD's due date.
 */
export function paydayFilingDueDate(payDateInput: string): string {
  let date = parseIsoDate(payDateInput, "Pay date");
  let workingDays = 0;
  while (workingDays < 2) {
    date = nextDay(date);
    const day = weekday(date);
    if (day !== 0 && day !== 6) workingDays += 1;
  }
  return date;
}

// The file

function sumOf(employees: readonly PaydayFilingEmployee[], pick: (employee: PaydayFilingEmployee) => string): Decimal {
  return employees.reduce((total, employee) => add(total, dec(pick(employee))), ZERO_DECIMAL);
}

function inside(date: string | null, start: string, end: string): boolean {
  return date !== null && date >= start && date <= end;
}

/**
 * Makes the EI file (PF1-PF5): the HEI2 header then a DEI line per
 * employee, in the order given, each line ending CR LF (decision 57).
 * `fileStem` names it: EI-<pay date>-<fileStem>.csv.
 */
export function makeEmploymentInformationFile(input: {
  header: PaydayFilingHeader;
  employees: readonly PaydayFilingEmployee[];
  fileStem: string;
}): PaydayFilingFile {
  const { header, employees } = input;
  if (employees.length === 0) throw new ValidationError("There's nobody on this pay run, so there's no employment information to file.");
  const payDate = dateField(header.payDate, "Pay date");
  const zero = "0";

  const lines = employees.map((employee) => {
    const label = nameField(employee.name);
    const taxCode = employee.taxCode.trim().replace(/\s+/g, " ").toUpperCase();
    if (!/^[A-Z ]{1,5}$/.test(taxCode)) throw new ValidationError(`${label}'s tax code ${taxCode} doesn't fit IRD's file.`);
    return [
      "DEI",
      irdNumberField(employee.irdNumber, `${label}'s IRD number`),
      label,
      taxCode,
      inside(employee.startDate, employee.periodStart, employee.periodEnd) ? dateField(employee.startDate!, "Start date") : "",
      inside(employee.finishDate, employee.periodStart, employee.periodEnd) ? dateField(employee.finishDate!, "Finish date") : "",
      dateField(employee.periodStart, "Pay period start"),
      dateField(employee.periodEnd, "Pay period end"),
      PAY_CYCLE_CODES[employee.payFrequency],
      hundredths(employee.hours, `${label}'s hours`),
      hundredths(employee.grossEarnings, `${label}'s gross earnings`),
      zero, // prior period gross adjustments
      hundredths(employee.notLiableForAccLevy ?? "0", `${label}'s earnings not liable for the ACC earners' levy`),
      employee.lumpSumLowestRate ? "1" : zero, // lump sum indicator
      hundredths(employee.paye, `${label}'s PAYE`),
      zero, // prior period PAYE adjustment
      zero, // child support
      "", // child support code
      hundredths(employee.studentLoan, `${label}'s student loan`),
      zero, // SLCIR
      zero, // SLBOR
      hundredths(employee.kiwiSaverDeductions, `${label}'s KiwiSaver deductions`),
      hundredths(employee.kiwiSaverEmployerNet, `${label}'s employer KiwiSaver contributions`),
      hundredths(employee.esct, `${label}'s ESCT`),
      zero, // tax credits for payroll donations
      zero, // family tax credits
      zero, // Employee Share Scheme
    ].join(",");
  });

  const total = (pick: (employee: PaydayFilingEmployee) => string) => sumOf(employees, pick);
  const gross = total((employee) => employee.grossEarnings);
  const paye = total((employee) => employee.paye);
  const studentLoan = total((employee) => employee.studentLoan);
  const kiwiSaver = total((employee) => employee.kiwiSaverDeductions);
  const employerNet = total((employee) => employee.kiwiSaverEmployerNet);
  const esct = total((employee) => employee.esct);
  const notLiable = total((employee) => employee.notLiableForAccLevy ?? "0");
  const deducted = [paye, studentLoan, kiwiSaver, employerNet, esct].reduce(add, ZERO_DECIMAL);
  const money = (value: Decimal) => toFixedString(value, 2);

  const packageIdentifier = header.packageIdentifier;
  if (packageIdentifier.length === 0 || packageIdentifier.length > 80 || packageIdentifier.includes(",")) {
    throw new ValidationError("The payroll package identifier must be 1 to 80 characters with no commas.");
  }
  const headerLine = [
    "HEI2",
    irdNumberField(header.employerIrdNumber, "The employer's IRD number"),
    payDate,
    "N", // final return
    "N", // nil return
    "", // PAYE intermediary
    parseContactName(header.contactName),
    parseContactPhone(header.contactPhone),
    parseContactEmail(header.contactEmail),
    String(employees.length),
    hundredths(money(gross), "Total gross earnings"),
    zero, // prior period gross adjustments
    hundredths(money(notLiable), "Total earnings not liable for the ACC earners' levy"),
    hundredths(money(paye), "Total PAYE"),
    zero, // prior period PAYE adjustment
    zero, // child support
    hundredths(money(studentLoan), "Total student loan"),
    zero, // SLCIR
    zero, // SLBOR
    hundredths(money(kiwiSaver), "Total KiwiSaver deductions"),
    hundredths(money(employerNet), "Total employer KiwiSaver contributions"),
    hundredths(money(esct), "Total ESCT"),
    hundredths(money(deducted), "Total amounts deducted"),
    zero, // payroll donations
    zero, // family tax credits
    zero, // Employee Share Scheme
    packageIdentifier,
    IR_FORM_VERSION,
  ].join(",");

  return {
    fileName: `EI-${payDate}-${input.fileStem}.csv`,
    contentType: "text/csv; charset=utf-8",
    content: [headerLine, ...lines].map((line) => `${line}\r\n`).join(""),
    employeeLines: employees.length,
    totals: {
      grossEarnings: money(gross),
      paye: money(paye),
      studentLoan: money(studentLoan),
      kiwiSaverDeductions: money(kiwiSaver),
      kiwiSaverEmployerNet: money(employerNet),
      esct: money(esct),
      amountsDeducted: money(deducted),
    },
  };
}
