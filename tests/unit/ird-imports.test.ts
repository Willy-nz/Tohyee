import { describe, expect, it } from "vitest";
import { distinctValues, findHeadings, guessHeaderRow, headingsAt, type IrdImportMapping, suggestAppliesTo, suggestKind } from "@/lib/tax/income/ird-import-kinds";
import { mappingProblems, parseMapping, parseRows, readIrdImportFile } from "@/lib/tax/income/ird-imports";

/** Importing IRD account files (ITX-IMP1 to ITX-IMP5; as delegated, not yet reviewed). The files are made up. */

const FILE_A = [
  "Kererū Joinery Ltd income tax (made-up file)",
  "Date,Transaction,Period,Debit,Credit,Instalment",
  "01/04/2026,Balance brought forward,31/03/2027,,,",
  '28/08/2026,Payment,31/03/2027,,"6,183.80",Instalment 1',
  '15/01/2027,Payment,31/03/2027,,"6,183.80",',
  "20/01/2027,Interest,31/03/2027,12.40,,",
  "25/01/2027,Interest,31/03/2027,,12.40,",
  "02/02/2027,Late payment penalty,31/03/2027,50.00,,",
].join("\n");

const read = (text: string, fileName = "kereru.csv") => readIrdImportFile({ fileName, fileBase64: Buffer.from(text, "utf8").toString("base64") });

const MAPPING_A: IrdImportMapping = {
  headerRow: 1,
  columns: { date: "Date", type: "Transaction", period: "Period", debit: "Debit", credit: "Credit", appliesTo: "Instalment" },
  dateOrder: "dmy",
  kindValues: { payment: "payment", interest: "interest", "late payment penalty": "penalty", "balance brought forward": "skip" },
  appliesToValues: { "instalment 1": "instalment_1" },
};

describe("IRD account file imports: reading and mapping", () => {
  it("ITX-IMP1 reads a CSV, refuses a PDF and an old .xls", () => {
    const file = read(FILE_A);
    expect(file.rows).toHaveLength(8);
    expect(file.contentType).toBe("text/csv");
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => read("%PDF-1.4\n%%EOF", "statement.pdf")).toThrow(/That's a PDF/);
    expect(() => read("a,b", "old.xls")).toThrow(/\.xls/);
    expect(() => readIrdImportFile({ fileName: "x.csv", fileBase64: "" })).toThrow(/Choose a CSV/);
  });

  it("ITX-IMP2 guesses the headings row after a title line, and lists the headings", () => {
    const { rows } = read(FILE_A);
    expect(guessHeaderRow(rows)).toBe(1);
    expect(headingsAt(rows, 1)).toEqual(["Date", "Transaction", "Period", "Debit", "Credit", "Instalment"]);
    expect(headingsAt([["Date", "", "Date"], ["1", "2", "3"]], 0)).toEqual(["Date", "Column 2", "Date (2)"]);
  });

  it("ITX-IMP3 finds a saved mapping's headings in a new file, ignoring case and spaces", () => {
    const { rows } = read(FILE_A.replace("Date,Transaction", "date , TRANSACTION"));
    expect(findHeadings(rows, ["Date", "Transaction", "Period", "Debit", "Credit", "Instalment"])).toBe(1);
    expect(findHeadings(rows, ["Date", "Amount"])).toBeNull();
  });

  it("ITX-IMP2 the mapping's own problems are named", () => {
    const headings = ["Date", "Transaction", "Amount"];
    expect(mappingProblems({ headerRow: 0, columns: {}, dateOrder: "dmy", kindValues: {}, appliesToValues: {} }, headings, { fileIncomeYear: null })).toEqual([
      "Choose the Date column.",
      "Choose the Amount column, or the Debit and Credit columns.",
      "Choose the Type column, or say what every row in the file is.",
      "Choose the Period column, or the income year the whole file is for.",
    ]);
    expect(mappingProblems({ headerRow: 0, columns: { date: "Date", amount: "Amount", debit: "Amount" }, dateOrder: "dmy", kindValues: {}, defaultKind: "payment", appliesToValues: {} }, headings, { fileIncomeYear: 2027 })).toEqual([
      "Each column can be used for one thing only.",
      "Use either one Amount column, or Debit and Credit columns, not both.",
      "Say which way round the Amount column is: is a positive amount something you owe, or a payment?",
    ]);
    expect(mappingProblems({ ...MAPPING_A, columns: { ...MAPPING_A.columns, reference: "Ref" } }, headingsAt(read(FILE_A).rows, 1), { fileIncomeYear: null })).toEqual(['The file has no "Ref" column (chosen for reference).']);
  });

  it("ITX-IMP4 lists each type value with its count, and suggests from plain words only", () => {
    const { rows } = read(FILE_A);
    expect(distinctValues(rows, 1, "Transaction")).toEqual([
      { key: "balance brought forward", text: "Balance brought forward", count: 1 },
      { key: "payment", text: "Payment", count: 2 },
      { key: "interest", text: "Interest", count: 2 },
      { key: "late payment penalty", text: "Late payment penalty", count: 1 },
    ]);
    expect(suggestKind("Late payment penalty")).toBe("penalty");
    expect(suggestKind("Interest charged")).toBe("interest");
    expect(suggestKind("Payment")).toBe("payment");
    expect(suggestKind("Return assessed")).toBe("assessment");
    expect(suggestKind("Transfer in")).toBe("credit");
    expect(suggestKind("Balance brought forward")).toBeNull();
    expect(suggestAppliesTo("Instalment 2")).toBe("instalment_2");
    expect(suggestAppliesTo("installment 3")).toBe("instalment_3");
    expect(suggestAppliesTo("P1")).toBe("instalment_1");
    expect(suggestAppliesTo("28 Aug")).toBeNull();
  });

  it("ITX-IMP4, ITX-IMP5 file A becomes five proposed rows, with the balance line left out", () => {
    const { rows } = read(FILE_A);
    const parsed = parseRows(rows, MAPPING_A, { fileIncomeYear: null, endMonth: 3 });
    expect(parsed.every((row) => row.problems.length === 0)).toBe(true);
    expect(parsed[0]).toMatchObject({ row: 3, kind: null, skipped: '"Balance brought forward" rows are set to be left out.' });
    expect(parsed.slice(1).map((row) => [row.row, row.kind, row.incomeYear, row.transactionOn, row.direction, row.amount, row.appliesTo])).toEqual([
      [4, "payment", 2027, "2026-08-28", "credit", "6183.80", "instalment_1"],
      [5, "payment", 2027, "2027-01-15", "credit", "6183.80", null],
      [6, "interest", 2027, "2027-01-20", "debit", "12.40", null],
      [7, "interest", 2027, "2027-01-25", "credit", "12.40", null],
      [8, "penalty", 2027, "2027-02-02", "debit", "50.00", null],
    ]);
    expect(parsed[1].appliesToText).toBe("Instalment 1");
  });

  it("ITX-IMP2 rows with problems are named: an unmapped type, a bad date, both debit and credit", () => {
    const { rows } = read(`${FILE_A}\n31/02/2027,Payment,31/03/2027,,10.00,\n01/03/2027,Refund,31/03/2027,5.00,5.00,`);
    const parsed = parseRows(rows, MAPPING_A, { fileIncomeYear: null, endMonth: 3 });
    expect(parsed.at(-2)?.problems).toEqual(['Date "31/02/2027" isn\'t a date Tohyee can read.']);
    expect(parsed.at(-1)?.problems).toEqual(['Say what "Refund" rows are.', "Both Debit and Credit have an amount."]);
  });

  it("ITX-IMP5 one signed Amount column, the file's income year, and a default kind", () => {
    const rows = [
      ["Processed", "Effective", "Amount"],
      ["29/08/2026", "28/08/2026", "6183.80"],
      ["20/01/2027", "", "-12.40"],
      ["21/01/2027", "", "(1,000.00)"],
      ["22/01/2027", "", "6183.0999999999999"],
    ];
    const mapping: IrdImportMapping = { headerRow: 0, columns: { date: "Processed", effectiveDate: "Effective", amount: "Amount" }, dateOrder: "dmy", amountSign: "positive_is_credit", kindValues: {}, defaultKind: "payment", appliesToValues: {} };
    const parsed = parseRows(rows, mapping, { fileIncomeYear: 2027, endMonth: 3 });
    expect(parsed.map((row) => [row.kind, row.incomeYear, row.transactionOn, row.effectiveOn, row.direction, row.amount])).toEqual([
      ["payment", 2027, "2026-08-29", "2026-08-28", "credit", "6183.80"],
      ["payment", 2027, "2027-01-20", null, "debit", "12.40"],
      ["payment", 2027, "2027-01-21", null, "debit", "1000.00"],
      ["payment", 2027, "2027-01-22", null, "credit", "6183.10"],
    ]);
    const owed = parseRows(rows, { ...mapping, amountSign: "positive_is_debit" }, { fileIncomeYear: 2027, endMonth: 3 });
    expect(owed.map((row) => row.direction)).toEqual(["debit", "credit", "credit", "debit"]);
    const noYear = parseRows(rows, mapping, { fileIncomeYear: null, endMonth: 3 });
    expect(noYear[0].problems).toEqual(["No period, and no income year chosen for the file."]);
  });

  it("ITX-IMP5 the period gives the income year: a year, or a date in it for the balance date", () => {
    const rows = [
      ["Date", "Period", "Credit"],
      ["28/08/2026", "2027", "1.00"],
      ["28/08/2026", "31-Mar-2027", "1.00"],
      ["28/08/2026", "31/05/2027", "1.00"],
      ["28/08/2026", "soon", "1.00"],
    ];
    const mapping: IrdImportMapping = { headerRow: 0, columns: { date: "Date", period: "Period", credit: "Credit" }, dateOrder: "dmy", kindValues: {}, defaultKind: "payment", appliesToValues: {} };
    const march = parseRows(rows, mapping, { fileIncomeYear: null, endMonth: 3 });
    expect(march.map((row) => row.incomeYear)).toEqual([2027, 2027, 2028, null]);
    expect(march[3].problems).toEqual(['Period "soon" isn\'t a year or a date Tohyee can read.']);
    // A 31 May balance date: 31 May 2027 is the 2027 income year (ITX41).
    expect(parseRows(rows, mapping, { fileIncomeYear: null, endMonth: 5 })[2].incomeYear).toBe(2027);
  });

  it("checks a mapping sent by the browser", () => {
    expect(parseMapping(MAPPING_A)).toEqual(MAPPING_A);
    expect(() => parseMapping({ ...MAPPING_A, headerRow: 25 })).toThrow(/first 20/);
    expect(() => parseMapping({ ...MAPPING_A, columns: { amountish: "x" } })).toThrow(/doesn't know/);
    expect(() => parseMapping({ ...MAPPING_A, kindValues: { payment: "bribe" } })).toThrow();
    expect(parseMapping({ ...MAPPING_A, kindValues: { "  Late  Payment Penalty ": "penalty" } }).kindValues).toEqual({ "late payment penalty": "penalty" });
  });
});
