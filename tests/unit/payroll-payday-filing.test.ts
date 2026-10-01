import { describe, expect, it } from "vitest";
import {
  hundredths,
  irdNumberField,
  makeEmploymentInformationFile,
  nameField,
  parseContactEmail,
  parseContactName,
  parseContactPhone,
  parseEmployerIrdNumber,
  type PaydayFilingEmployee,
  type PaydayFilingHeader,
  paydayFilingDueDate,
} from "@/lib/payroll/payday-filing";

/**
 * Examples PF1-PF7 in docs/ACCOUNTING-EXAMPLES.md ("Payday filing file
 * (examples not yet approved by Jess)"): IRD's employment information
 * file, byte for byte.
 */

const header: PaydayFilingHeader = {
  employerIrdNumber: "123123123",
  payDate: "2026-10-14",
  contactName: "Mere Tipene",
  contactPhone: "034771234",
  contactEmail: "payroll@harbourcafe.co.nz",
  packageIdentifier: "Tohyee_Tohyee_v0.3.1",
};

const HEADER_START = "HEI2,123123123,20261014,N,N,,Mere Tipene,034771234,payroll@harbourcafe.co.nz";
const HEADER_END = "Tohyee_Tohyee_v0.3.1,0001";

const blank = {
  startDate: "2026-04-01",
  finishDate: null,
  studentLoan: "0.00",
  kiwiSaverDeductions: "0.00",
  kiwiSaverEmployerNet: "0.00",
  esct: "0.00",
  hours: "0.00",
};

const kiri: PaydayFilingEmployee = {
  ...blank,
  irdNumber: "87654321",
  name: "Kiri Tane",
  taxCode: "M",
  periodStart: "2026-09-28",
  periodEnd: "2026-10-11",
  payFrequency: "fortnightly",
  grossEarnings: "2000.00",
  paye: "343.00",
};

const hemi: PaydayFilingEmployee = {
  ...blank,
  irdNumber: "123456789",
  name: "Hemi Walker",
  taxCode: "M",
  periodStart: "2026-09-28",
  periodEnd: "2026-10-11",
  payFrequency: "fortnightly",
  grossEarnings: "2692.31",
  paye: "555.58",
  kiwiSaverDeductions: "94.23",
  kiwiSaverEmployerNet: "66.03",
  esct: "28.20",
};

const sione: PaydayFilingEmployee = {
  ...blank,
  irdNumber: "100200300",
  name: "Sione Fifita",
  taxCode: "M",
  periodStart: "2026-10-05",
  periodEnd: "2026-10-11",
  payFrequency: "weekly",
  hours: "36.00",
  grossEarnings: "880.00",
  paye: "148.40",
  kiwiSaverDeductions: "35.20",
  kiwiSaverEmployerNet: "25.55",
  esct: "5.25",
};

const aroha: PaydayFilingEmployee = {
  ...blank,
  irdNumber: "112233445",
  name: "Aroha Ngata",
  taxCode: "M SL",
  periodStart: "2026-09-14",
  periodEnd: "2026-10-11",
  payFrequency: "four_weekly",
  grossEarnings: "3500.00",
  paye: "589.72",
  studentLoan: "197.28",
  kiwiSaverDeductions: "122.50",
  kiwiSaverEmployerNet: "101.15",
  esct: "21.35",
};

describe("employment information file (PF1-PF5)", () => {
  it("PF1: fortnightly salaries, byte for byte", () => {
    const file = makeEmploymentInformationFile({ header, employees: [kiri, hemi], fileStem: "PAYRUN-1" });
    expect(file.fileName).toBe("EI-20261014-PAYRUN-1.csv");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(file.content).toBe(
      `${HEADER_START},2,469231,0,0,89858,0,0,0,0,0,9423,6603,2820,108704,0,0,0,${HEADER_END}\r\n` +
        "DEI,087654321,Kiri Tane,M,,,20260928,20261011,FT,0,200000,0,0,0,34300,0,0,,0,0,0,0,0,0,0,0,0\r\n" +
        "DEI,123456789,Hemi Walker,M,,,20260928,20261011,FT,0,269231,0,0,0,55558,0,0,,0,0,0,9423,6603,2820,0,0,0\r\n",
    );
    expect(file.employeeLines).toBe(2);
    expect(file.totals).toEqual({
      grossEarnings: "4692.31",
      paye: "898.58",
      studentLoan: "0.00",
      kiwiSaverDeductions: "94.23",
      kiwiSaverEmployerNet: "66.03",
      esct: "28.20",
      amountsDeducted: "1087.04",
    });
    const [headerLine, ...detail] = file.content.trimEnd().split("\r\n");
    expect(headerLine.split(",")).toHaveLength(28);
    for (const line of detail) expect(line.split(",")).toHaveLength(27);
  });

  it("PF2: hours from hours x rate lines; gross is taxable earnings only", () => {
    const file = makeEmploymentInformationFile({ header, employees: [sione], fileStem: "PAYRUN-2" });
    expect(file.content).toBe(
      `${HEADER_START},1,88000,0,0,14840,0,0,0,0,0,3520,2555,525,21440,0,0,0,${HEADER_END}\r\n` +
        "DEI,100200300,Sione Fifita,M,,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0\r\n",
    );
    expect(file.totals.amountsDeducted).toBe("214.40");
  });

  it("PF3: student loan, tax code M SL", () => {
    const file = makeEmploymentInformationFile({ header, employees: [aroha], fileStem: "PAYRUN-3" });
    expect(file.content).toBe(
      `${HEADER_START},1,350000,0,0,58972,0,0,19728,0,0,12250,10115,2135,103200,0,0,0,${HEADER_END}\r\n` +
        "DEI,112233445,Aroha Ngata,M SL,,,20260914,20261011,4W,0,350000,0,0,0,58972,0,0,,19728,0,0,12250,10115,2135,0,0,0\r\n",
    );
    expect(file.totals.amountsDeducted).toBe("1032.00");
  });

  it("PF5: a start date inside the pay period is filled in; one before it isn't", () => {
    const sina = { ...sione, irdNumber: "100200301", name: "Sina Fifita", startDate: "2026-10-07" };
    const file = makeEmploymentInformationFile({ header, employees: [sina, sione], fileStem: "PAYRUN-4" });
    const lines = file.content.split("\r\n");
    expect(lines[1]).toBe("DEI,100200301,Sina Fifita,M,20261007,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0");
    expect(lines[2].split(",")[4]).toBe("");
    const leaving = makeEmploymentInformationFile({ header, employees: [{ ...sione, finishDate: "2026-10-09" }], fileStem: "X" });
    expect(leaving.content.split("\r\n")[1].split(",")[5]).toBe("20261009");
    const later = makeEmploymentInformationFile({ header, employees: [{ ...sione, finishDate: "2026-12-01" }], fileStem: "X" });
    expect(later.content.split("\r\n")[1].split(",")[5]).toBe("");
  });

  it("PF7: an 8-digit employer IRD number gets a leading 0; commas in names become spaces", () => {
    const file = makeEmploymentInformationFile({
      header: { ...header, employerIrdNumber: "49091850" },
      employees: [{ ...kiri, name: "Kiri Tane, Jr" }],
      fileStem: "X",
    });
    expect(file.content.startsWith("HEI2,049091850,")).toBe(true);
    expect(file.content.split("\r\n")[1].split(",")[2]).toBe("Kiri Tane Jr");
  });

  it("refuses a file with nobody on it, negative amounts and more than 2 decimal places", () => {
    expect(() => makeEmploymentInformationFile({ header, employees: [], fileStem: "X" })).toThrow("nobody on this pay run");
    expect(() => makeEmploymentInformationFile({ header, employees: [{ ...kiri, paye: "-1.00" }], fileStem: "X" })).toThrow("can't be below zero");
    expect(() => makeEmploymentInformationFile({ header, employees: [{ ...kiri, hours: "1.125" }], fileStem: "X" })).toThrow("more than 2 decimal places");
  });
});

describe("field formats", () => {
  it("writes amounts and hours in hundredths with no decimal point", () => {
    expect(hundredths("2692.31", "x")).toBe("269231");
    expect(hundredths("36", "x")).toBe("3600");
    expect(hundredths("0.00", "x")).toBe("0");
    expect(hundredths("0.05", "x")).toBe("5");
    expect(hundredths("37.5", "x")).toBe("3750");
  });

  it("pads IRD numbers to 9 digits and refuses all zeros", () => {
    expect(irdNumberField("87-654-321", "x")).toBe("087654321");
    expect(irdNumberField("123 456 789", "x")).toBe("123456789");
    expect(() => irdNumberField("1234567", "IRD number")).toThrow("IRD number must have 8 or 9 digits.");
    expect(() => irdNumberField("00000000", "IRD number")).toThrow("can't be all zeros");
  });

  it("collapses spaces in names", () => {
    expect(nameField("  Kiri   Tane ")).toBe("Kiri Tane");
  });
});

describe("payday filing settings (PF7)", () => {
  it("employer IRD number", () => {
    expect(parseEmployerIrdNumber("123-123-123")).toBe("123123123");
    expect(parseEmployerIrdNumber("49-091-850")).toBe("049091850");
    expect(() => parseEmployerIrdNumber("12-345")).toThrow("8 or 9 digits");
    expect(() => parseEmployerIrdNumber("ABC123456")).toThrow("8 or 9 digits");
    expect(() => parseEmployerIrdNumber("000-000-000")).toThrow("all zeros");
    expect(() => parseEmployerIrdNumber("")).toThrow("Enter the employer's IRD number.");
  });

  it("contact name: up to 20 characters, no commas", () => {
    expect(parseContactName(" Mere  Tipene ")).toBe("Mere Tipene");
    expect(() => parseContactName("Tipene, Mere")).toThrow("can't have a comma");
    expect(() => parseContactName("Merewhakaaro Tipene-Smith")).toThrow("up to 20 characters");
  });

  it("contact phone: up to 12 letters and digits once punctuation is dropped", () => {
    expect(parseContactPhone("03 477 1234")).toBe("034771234");
    expect(parseContactPhone("(03) 477-1234")).toBe("034771234");
    expect(parseContactPhone("+64 3 477 1234")).toBe("6434771234");
    expect(() => parseContactPhone("03 477 1234 ext 5678")).toThrow("up to 12 digits");
    expect(() => parseContactPhone("03,4771234")).toThrow("up to 12 digits");
  });

  it("contact email: IRD's characters, @domain, no double dots, up to 60", () => {
    expect(parseContactEmail("payroll@harbourcafe.co.nz")).toBe("payroll@harbourcafe.co.nz");
    expect(() => parseContactEmail("payroll+ird@harbourcafe.co.nz")).toThrow("letters, digits and @ - _ .");
    expect(() => parseContactEmail("payroll@harbourcafe..co.nz")).toThrow("like payroll@example.co.nz");
    expect(() => parseContactEmail("payroll.harbourcafe.co.nz")).toThrow("like payroll@example.co.nz");
    expect(() => parseContactEmail(`${"a".repeat(50)}@example.co.nz`)).toThrow("up to 60 characters");
  });
});

describe("due date (PF6)", () => {
  it("is 2 working days after the pay date, skipping weekends but not public holidays", () => {
    expect(paydayFilingDueDate("2026-10-14")).toBe("2026-10-16");
    expect(paydayFilingDueDate("2026-10-23")).toBe("2026-10-27");
    expect(paydayFilingDueDate("2026-10-24")).toBe("2026-10-27");
    expect(paydayFilingDueDate("2026-10-30")).toBe("2026-11-03");
  });
});
