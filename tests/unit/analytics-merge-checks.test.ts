import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAnalytics, loadCsv, runBuiltQuery } from "@/lib/analytics/engine";
import { buildShapeQuery, mergeCheckOutcome, mergeCheckSql } from "@/lib/analytics/shaping";

/** Merge steps can't silently multiply amounts (#387, decision 693; example MD4). Made-up data. */

const ORG = "merge-check-test";
let root: string;

const tables = new Map([
  [
    "invoices",
    [
      { name: "invoice_id", type: "BIGINT" },
      { name: "number", type: "VARCHAR" },
      { name: "total", type: "DECIMAL(18,2)" },
    ],
  ],
  [
    "invoice_lines",
    [
      { name: "invoice_id", type: "BIGINT" },
      { name: "line", type: "INTEGER" },
      { name: "net", type: "DECIMAL(18,2)" },
    ],
  ],
]);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-merge-"));
  const folder = path.join(root, "source");
  fs.mkdirSync(folder);
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  // MD4: invoice INV-1 for 100.00 with three lines (30.00, 30.00, 40.00); INV-2 has no lines yet.
  fs.writeFileSync(path.join(folder, "invoices.csv"), "invoice_id,number,total\n1,INV-1,100.00\n2,INV-2,50.00\n");
  fs.writeFileSync(path.join(folder, "lines.csv"), "invoice_id,line,net\n1,1,30.00\n1,2,30.00\n1,3,40.00\n");
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file: path.join(folder, "invoices.csv"),
    table: "invoices",
    columns: [
      { source: "invoice_id", name: "invoice_id", kind: "integer" },
      { source: "number", name: "number", kind: "text" },
      { source: "total", name: "total", kind: "money" },
    ],
  });
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file: path.join(folder, "lines.csv"),
    table: "invoice_lines",
    columns: [
      { source: "invoice_id", name: "invoice_id", kind: "integer" },
      { source: "line", name: "line", kind: "integer" },
      { source: "net", name: "net", kind: "money" },
    ],
  });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

async function check(baseTable: string, steps: unknown[]): Promise<string[]> {
  const built = buildShapeQuery({ baseTable, tables, steps });
  const notes: string[] = [];
  for (const merge of built.merges) {
    const [answer] = await runBuiltQuery(ORG, mergeCheckSql(built.ctes, merge), built.params);
    notes.push(...mergeCheckOutcome(merge, baseTable, answer as Parameters<typeof mergeCheckOutcome>[2]));
  }
  return notes;
}

describe("Merge step checks (decision 693)", () => {
  const byInvoice = [{ column: "invoice_id", withColumn: "invoice_id" }];

  it("refuses merging an invoice with its three lines, which would turn 100.00 into 300.00", async () => {
    const steps = [{ type: "merge", table: "invoice_lines", join: "left", matches: byInvoice, columns: [{ column: "net", name: "line_net" }] }];
    // What it would have done, to show why: INV-1's total three times.
    const built = buildShapeQuery({ baseTable: "invoices", tables, steps });
    const [repeated] = await runBuiltQuery(ORG, `with ${built.ctes} select sum(total)::varchar as total from shape1 where invoice_id = 1`, built.params);
    expect(repeated.total).toBe("300.00");
    await expect(check("invoices", steps)).rejects.toThrow(
      /Step 1: invoice_lines has more than one row for the same invoice_id \(1 has 3 rows\), so each matching row here would be repeated/,
    );
    // Bringing nothing in still repeats the rows, so it's still refused.
    await expect(check("invoices", [{ type: "merge", table: "invoice_lines", join: "inner", matches: byInvoice, columns: [] }])).rejects.toThrow(/more than one row/);
  });

  it("lets lines look up their invoice's number, but not its total", async () => {
    const lookup = [{ type: "merge", table: "invoices", join: "left", matches: byInvoice, columns: [{ column: "number", name: "invoice_number" }] }];
    expect(await check("invoice_lines", lookup)).toEqual([]);
    const built = buildShapeQuery({ baseTable: "invoice_lines", tables, steps: lookup });
    const [summed] = await runBuiltQuery(ORG, `with ${built.ctes} select sum(net)::varchar as net, count(*) as lines from shape1`, built.params);
    expect(summed).toEqual({ net: "100.00", lines: "3" });

    const total = [{ type: "merge", table: "invoices", join: "left", matches: byInvoice, columns: [{ column: "total", name: "invoice_total" }] }];
    await expect(check("invoice_lines", total)).rejects.toThrow(/several rows here have the same invoice_id, so total from invoices would repeat on each of them/);
  });

  it("brings a number across once the lines are grouped to one row per invoice", async () => {
    const steps = [
      { type: "group", by: ["invoice_id"], aggregates: [{ operation: "sum", column: "net", name: "lines_net" }] },
      { type: "merge", table: "invoices", join: "inner", matches: byInvoice, columns: [{ column: "total", name: "invoice_total" }] },
    ];
    expect(await check("invoice_lines", steps)).toEqual([]);
    const built = buildShapeQuery({ baseTable: "invoice_lines", tables, steps });
    expect(await runBuiltQuery(ORG, `with ${built.ctes} select lines_net::varchar as net, invoice_total::varchar as total from shape2`, built.params)).toEqual([
      { net: "100.00", total: "100.00" },
    ]);
  });

  it("counts rows with no match", async () => {
    // Each invoice looks up the invoice with twice its id: 1 finds 2, and 2 finds nothing.
    const missing = [
      { type: "calculated", name: "twice", expression: { type: "arithmetic", left: { type: "column", name: "invoice_id" }, operator: "*", right: { type: "number", value: "2" } } },
      { type: "merge", table: "invoices", join: "left", matches: [{ column: "twice", withColumn: "invoice_id" }], columns: [{ column: "number", name: "other_number" }] },
    ];
    expect(await check("invoices", missing)).toEqual(["Step 2: 1 of 2 rows of invoices have no match in invoices; what they'd bring in is blank."]);
    const inner = [missing[0], { ...missing[1], join: "inner" }];
    expect(await check("invoices", inner)).toEqual(["Step 2: 1 of 2 rows of invoices have no match in invoices and are left out."]);
  });
});
