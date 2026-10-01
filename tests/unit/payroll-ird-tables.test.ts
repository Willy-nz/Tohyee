import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateEsct,
  calculatePaye,
  calculateStudentLoan,
  kiwiSaverEmployeeContribution,
  kiwiSaverEmployerContribution,
} from "@/lib/payroll/calculations";

type Table = {
  document: string;
  edition: string;
  ratesEdition: string;
  payDate: string;
  frequency: string;
  kind: "main" | "secondary";
  lowestKiwiSaverRate: string;
  rows: { page: number; values: string[] }[];
};

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "ird-paye-tables.json"), "utf8"),
) as { tables: Table[] };

const ESCT_RATES = ["10.5", "17.5", "30", "33", "39"];

/** Tohyee's figures in the table's column order. */
function tohyeeRow(table: Table, gross: string): string[] {
  const { frequency, payDate } = table;
  const pay = { gross, frequency, payDate };
  const row = [gross];
  if (table.kind === "main") {
    row.push(
      calculatePaye({ ...pay, taxCode: "M" }),
      calculatePaye({ ...pay, taxCode: "ME" }),
      calculateStudentLoan({ ...pay, taxCode: "M SL" }),
    );
  } else {
    for (const taxCode of ["SB", "S", "SH", "ST", "SA"]) {
      row.push(calculatePaye({ ...pay, taxCode }));
    }
    row.push(calculateStudentLoan({ ...pay, taxCode: "SB SL" }));
  }
  const kiwiSaverRates = [table.lowestKiwiSaverRate, "4", "6", "8", "10"];
  for (const rate of kiwiSaverRates) {
    row.push(kiwiSaverEmployeeContribution({ gross, rate, payDate }));
  }
  const employerContribution = kiwiSaverEmployerContribution({ gross, rate: table.lowestKiwiSaverRate, payDate });
  for (const esctRate of ESCT_RATES) {
    const { esct, netContribution } = calculateEsct({ employerContribution, esctRate, payDate });
    row.push(netContribution, esct);
  }
  return row;
}

describe("PR16: IRD's PAYE deduction tables IR340 and IR341", () => {
  it("has samples of every table in both years", () => {
    expect(fixture.tables.map((table) => `${table.document} ${table.edition} ${table.frequency} ${table.kind}`)).toEqual(
      expect.arrayContaining([
        "IR340 April 2025 weekly main",
        "IR340 April 2025 fortnightly secondary",
        "IR340 April 2026 weekly secondary",
        "IR340 April 2026 fortnightly main",
        "IR341 April 2025 four-weekly main",
        "IR341 April 2025 monthly secondary",
        "IR341 April 2026 four-weekly secondary",
        "IR341 April 2026 monthly main",
      ]),
    );
    expect(fixture.tables).toHaveLength(16);
    expect(fixture.tables.reduce((count, table) => count + table.rows.length, 0)).toBe(976);
  });

  for (const table of fixture.tables) {
    it(`${table.document} ${table.edition}, ${table.frequency} ${table.kind} (${table.ratesEdition} rates)`, () => {
      for (const { page, values } of table.rows) {
        expect(tohyeeRow(table, values[0]), `page ${page}, earnings ${values[0]}`).toEqual(values);
      }
    });
  }
});
