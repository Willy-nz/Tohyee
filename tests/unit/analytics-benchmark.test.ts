import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { closeAnalytics, loadCsv, queryAnalytics } from "@/lib/analytics/engine";
import { toFixedString } from "@/lib/money/decimal";
import { columns, queries, totalFromCsv, writeSalesCsv } from "../../scripts/analytics-benchmark";

const org = "benchmark-test";
let folder: string;
const previousFolder = process.env.TOHYEE_ANALYTICS_DIR;

beforeAll(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-benchmark-test-"));
  process.env.TOHYEE_ANALYTICS_DIR = folder;
});

afterAll(async () => {
  await closeAnalytics(org);
  if (previousFolder === undefined) delete process.env.TOHYEE_ANALYTICS_DIR;
  else process.env.TOHYEE_ANALYTICS_DIR = previousFolder;
  fs.rmSync(folder, { recursive: true, force: true });
});

it("writes identical CSV bytes for the same integer seed, with bounded dates and exact prices", async () => {
  const first = path.join(folder, "first.csv");
  const second = path.join(folder, "second.csv");
  await writeSalesCsv(first, 10_000);
  await writeSalesCsv(second, 10_000);
  expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
  const lines = fs.readFileSync(first, "utf8").trimEnd().split("\n");
  expect(lines.shift()).toBe("order_id,order_date,customer,region,product,quantity,unit_price,cost");
  expect(lines).toHaveLength(10_000);
  const regions = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const [id, date, customer, region, product, quantity, price, cost] = line.split(",");
    expect(id).toBe(String(index + 1));
    expect(date >= "2024-01-01" && date <= "2026-09-30").toBe(true);
    expect(customer).toMatch(/^Customer \d+$/);
    expect(Number(customer.slice(9))).toBeGreaterThanOrEqual(1);
    expect(Number(customer.slice(9))).toBeLessThanOrEqual(5_000);
    regions.add(region);
    expect(product).toMatch(/^SKU \d+$/);
    expect(Number(product.slice(4))).toBeGreaterThanOrEqual(1);
    expect(Number(product.slice(4))).toBeLessThanOrEqual(800);
    expect(Number(quantity)).toBeGreaterThanOrEqual(1);
    expect(Number(quantity)).toBeLessThanOrEqual(20);
    expect(price).toMatch(/^\d+\.\d{2}$/);
    expect(cost).toMatch(/^\d+\.\d{2}$/);
  }
  expect(regions.size).toBe(8);
});

it("checks CSV text and report queries against small, exact synthetic sales", async () => {
  const file = path.join(folder, "sales.csv");
  fs.writeFileSync(file,
    "order_id,order_date,customer,region,product,quantity,unit_price,cost\n" +
    "1,2024-01-01,Customer 1,Auckland,SKU 1,2,0.10,0.05\n" +
    "2,2025-01-01,Customer 1,Auckland,SKU 1,3,0.20,0.10\n" +
    "3,2025-01-31,Customer 2,Auckland,SKU 2,1,0.10,0.05\n" +
    "4,2025-01-01,Customer 3,Otago,SKU 2,1,1.00,0.50\n");
  expect(toFixedString(await totalFromCsv(file), 2)).toBe("1.90");
  expect((await loadCsv({ organisationId: org, sourceFolder: folder, file, table: "sales", columns })).rows).toBe(4);
  const monthly = await queryAnalytics(org, queries[0].sql);
  expect(monthly.find((row) => row.month === "2025-01" && row.region === "Auckland")).toMatchObject({
    sales: "0.700000", last_year_sales: "0.200000",
  });
  expect(await queryAnalytics(org, queries[1].sql)).toEqual([
    { customer: "Customer 1", sales: "0.600000" },
    { customer: "Customer 2", sales: "0.100000" },
  ]);
  const margins = await queryAnalytics(org, queries[2].sql);
  expect(margins).toHaveLength(2);
  expect(margins.every((row) => row.gross_margin_percent === "50.00")).toBe(true);
});

it("runs the CLI with real DuckDB and appends its Markdown table to the job summary", () => {
  const summary = path.join(folder, "summary.md");
  fs.writeFileSync(summary, "Existing summary\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/analytics-benchmark.ts", "100"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("| Load CSV |");
  expect(result.stdout).toContain("| CSV size (bytes) |");
  expect(result.stdout).toContain("| DuckDB size (bytes) |");
  expect(result.stdout).toContain("| Peak sampled RSS (bytes) |");
  expect(result.stdout).toContain("Exact sales total:");
  expect(fs.readFileSync(summary, "utf8")).toBe(`Existing summary\n${result.stdout}`);
});

it.each(["0", "-1", "1.5", "abc", "9007199254740992"])("rejects invalid row count %s", (rows) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/analytics-benchmark.ts", rows], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Rows must be a positive safe integer.");
});
