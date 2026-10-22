import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnValues, runPivotDrilldown, runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import type { AnalyticsModel } from "@/lib/analytics/model";
import { modelTables } from "@/lib/analytics/model";
import { parseTileQuery } from "@/lib/analytics/query";
import { checkRelationship, type Relationship } from "@/lib/analytics/relationships";

/** Relationships between tables (#376 phase 4, decision 774; examples RL1-RL6, #387's MD4). Made-up data. */

const ORG = "relationships-test";
let root: string;
let folder: string;

async function load(name: string, header: string, rows: string[], columns: Array<{ source: string; name: string; kind: string }>) {
  const file = path.join(folder, `${name}.csv`);
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  await loadCsv({ organisationId: ORG, sourceFolder: folder, file, table: name, columns: columns as never });
}

const invoices = (rows: string[]) =>
  load("invoices", "id,number,customer,total", rows, [
    { source: "id", name: "id", kind: "integer" },
    { source: "number", name: "number", kind: "text" },
    { source: "customer", name: "customer", kind: "text" },
    { source: "total", name: "total", kind: "money" },
  ]);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-rel-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  folder = path.join(root, "src");
  fs.mkdirSync(folder);
  // MD4: INV-1 for 100.00 has three lines (30.00, 30.00, 40.00); INV-2 for 50.00 has one; a line points at an invoice that isn't there.
  await invoices(["1,INV-1,Kererū Café,100.00", "2,INV-2,Tūī Books,50.00"]);
  await load("lines", "invoice_id,product,quantity,amount", ["1,P1,1,30.00", "1,P1,1,30.00", "1,P2,2,40.00", "2,P2,1,50.00", "9,P1,1,5.00", ",P1,1,1.00"], [
    { source: "invoice_id", name: "invoice_id", kind: "text" },
    { source: "product", name: "product", kind: "text" },
    { source: "quantity", name: "quantity", kind: "integer" },
    { source: "amount", name: "amount", kind: "money" },
  ]);
  await load("products", "code,name,price", ["P1,Mug,30.00", "P2,Bowl,20.00"], [
    { source: "code", name: "code", kind: "text" },
    { source: "name", name: "name", kind: "text" },
    { source: "price", name: "price", kind: "money" },
  ]);
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const invoice: Relationship = { id: "1", table: "lines", field: "invoice_id", dimension: "invoices", dimensionField: "id", name: "invoice", keyType: "BIGINT" };
const product: Relationship = { id: "2", table: "lines", field: "product", dimension: "products", dimensionField: "code", name: "product", keyType: "VARCHAR" };
const model: AnalyticsModel = { fields: [], relationships: [invoice, product] };
const byCustomer = (measures: unknown[], extra: Record<string, unknown> = {}) => ({
  table: "lines",
  groupBy: { field: "invoice.customer" },
  measures,
  filters: [],
  dateField: null,
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});

describe("RL1: lines grouped by their invoice's customer", () => {
  it("adds the lines once each: INV-1 is 100.00, not 300.00", async () => {
    const result = await runTile(ORG, byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }, { label: "Lines", aggregate: "count" }, { label: "Invoices", aggregate: "count_distinct", field: "invoice.number" }]), {}, { model });
    expect(result.rows).toEqual([
      { category: "Kererū Café", m0: "100.00", m1: "3", m2: "1" },
      { category: "Tūī Books", m0: "50.00", m1: "1", m2: "1" },
      { category: null, m0: "6.00", m1: "2", m2: "0" },
    ]);
  });

  it("says how many rows have no match (their related fields are blank)", async () => {
    const result = await runTile(ORG, byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }]), {}, { model });
    expect(result.notes).toEqual(["2 of 6 lines rows have no matching invoices row, so their invoice fields are blank."]);
  });

  it("filters, slices and drills through by a related field", async () => {
    const filtered = await runTile(ORG, { ...byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }]), groupBy: { field: "product.name" }, filters: [{ field: "invoice.customer", op: "eq", value: "Kererū Café" }] }, {}, { model });
    expect(filtered.rows.map((row) => [row.category, row.m0])).toEqual([
      ["Bowl", "40.00"],
      ["Mug", "60.00"],
    ]);
    expect((await columnValues(ORG, "lines", "invoice.customer", model)).values).toEqual(["Kererū Café", "Tūī Books"]);
    const pivot = { ...byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }]), groupBy: null, pivot: { rows: [{ field: "invoice.customer" }], column: null } };
    const drill = await runPivotDrilldown(ORG, pivot, {}, { depth: 1, dimensions: ["Kererū Café"], pivotValue: null, total: false }, model);
    expect(drill.rows.map((row) => row.d1)).toEqual(["30.00", "30.00", "40.00"]);
  });
});

describe("RL2: a dimension's numbers aren't added up through it", () => {
  it("refuses the invoice total on its lines, and allows counts, largest and price × quantity", async () => {
    const tables = modelTables(await listTables(ORG), model);
    expect(() => parseTileQuery(byCustomer([{ label: "Total", aggregate: "sum", field: "invoice.total" }]), tables)).toThrow(/would be 300.00/);
    expect(() => parseTileQuery(byCustomer([{ label: "Total", aggregate: "avg", field: "invoice.total" }]), tables)).toThrow(/comes from a related table/);
    const result = await runTile(ORG, byCustomer([{ label: "Largest invoice", aggregate: "max", field: "invoice.total" }, { label: "At list price", aggregate: "sum", field: "quantity", times: "product.price" }]), {}, { model });
    // INV-1's lines at list price: 1 × 30.00 + 1 × 30.00 + 2 × 20.00 = 100.00.
    expect(result.rows[0]).toMatchObject({ category: "Kererū Café", m0: "100.00", m1: "100.00" });
  });
});

describe("RL3: many-to-many and one-to-many are refused", () => {
  it("refuses relating invoices to their lines (each invoice has several)", async () => {
    await expect(checkRelationship(ORG, { id: "", table: "invoices", field: "id", dimension: "lines", dimensionField: "invoice_id", name: "line" })).rejects.toThrow(/lines has more than one row for the same invoice_id \(1 has 3 rows\).*300.00.*many-to-many isn't allowed/);
  });

  it("refuses an answer once a reload gives the dimension two rows for one key", async () => {
    await invoices(["1,INV-1,Kererū Café,100.00", "1,INV-1B,Kererū Café,100.00", "2,INV-2,Tūī Books,50.00"]);
    await expect(runTile(ORG, byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }]), {}, { model })).rejects.toThrow(/invoices has more than one row for the same id/);
    // A tile that doesn't use the relationship is unaffected (nothing is joined).
    const plain = await runTile(ORG, { ...byCustomer([{ label: "Sales", aggregate: "sum", field: "amount" }]), groupBy: { field: "product" } }, {}, { model });
    expect(plain.rows.map((row) => row.m0)).toEqual(["66.00", "90.00"]);
    await invoices(["1,INV-1,Kererū Café,100.00", "2,INV-2,Tūī Books,50.00"]);
  });
});

describe("RL4: the tables' fields", () => {
  it("lists a dimension's fields on its fact table, without its key", async () => {
    const tables = modelTables(await listTables(ORG), model);
    expect(tables.get("lines")!.map((column) => column.name)).toEqual(["invoice_id", "product", "quantity", "amount", "invoice.number", "invoice.customer", "invoice.total", "product.name", "product.price"]);
    expect(tables.get("invoices")!.map((column) => column.name)).toEqual(["id", "number", "customer", "total"]);
  });
});

describe("RL5: related fields are named for people", () => {
  it("shows a related field with its relationship first", async () => {
    const { fieldLabel } = await import("@/lib/analytics/labels");
    expect(fieldLabel("customer.billing_country")).toBe("Customer › billing country");
    expect(fieldLabel("contact_id")).toBe("Contact ID");
  });
});
