import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { analyticsFilePath, closeAnalytics, loadCsv, queryAnalytics, type LoadColumn } from "@/lib/analytics/engine";
import { add, cmp, dec, mul, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";

export const columns: LoadColumn[] = [
  { source: "order_id", name: "order_id", kind: "integer" },
  { source: "order_date", name: "order_date", kind: "date" },
  { source: "customer", name: "customer", kind: "text" },
  { source: "region", name: "region", kind: "text" },
  { source: "product", name: "product", kind: "text" },
  { source: "quantity", name: "quantity", kind: "quantity" },
  { source: "unit_price", name: "unit_price", kind: "money" },
  { source: "cost", name: "cost", kind: "money" },
];

export const queries = [
  {
    name: "Monthly sales by region vs last year",
    sql: `with monthly as (
      select date_trunc('month', order_date) as month, region, sum(quantity * unit_price) as sales
      from sales group by 1, 2
    )
    select strftime(current.month, '%Y-%m') as month, current.region,
      current.sales::varchar as sales, previous.sales::varchar as last_year_sales
    from monthly current left join monthly previous
      on previous.month = current.month - interval '1 year' and previous.region = current.region
    order by current.month, current.region`,
  },
  {
    name: "Top 20 customers in 2025, Auckland",
    sql: `select customer, sum(quantity * unit_price)::varchar as sales from sales
      where order_date >= date '2025-01-01' and order_date < date '2026-01-01' and region = 'Auckland'
      group by customer order by sum(quantity * unit_price) desc, customer limit 20`,
  },
  {
    name: "Gross margin % by month",
    sql: `select strftime(order_date, '%Y-%m') as month,
      cast(100 * (sum(quantity * unit_price) - sum(quantity * cost))
        / nullif(sum(quantity * unit_price), 0) as decimal(18,2))::varchar as gross_margin_percent
      from sales group by 1 order by 1`,
  },
];

export async function writeSalesCsv(file: string, rows: number, seed = 353): Promise<void> {
  // xorshift32 uses only 32-bit integer operations, including on Windows.
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const regions = ["Auckland", "Waikato", "Bay of Plenty", "Wellington", "Nelson", "Canterbury", "Otago", "Southland"];
  const dates: string[] = [];
  for (let day = Date.UTC(2024, 0, 1); day <= Date.UTC(2026, 8, 30); day += 86_400_000) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  function* chunks() {
    yield `${columns.map((column) => column.source).join(",")}\n`;
    let chunk = "";
    for (let index = 0; index < rows; index++) {
      const date = dates[next() % dates.length];
      const customer = `Customer ${next() % 5_000 + 1}`;
      const region = regions[next() % regions.length];
      const product = `SKU ${next() % 800 + 1}`;
      const quantity = String(next() % 20 + 1);
      const price = toFixedString({ units: BigInt(next() % 100_000 + 1), scale: 2 }, 2);
      const cost = toFixedString({ units: BigInt(next() % 50_000 + 1), scale: 2 }, 2);
      chunk += `${index + 1},${date},${customer},${region},${product},${quantity},${price},${cost}\n`;
      if ((index + 1) % 1_000 === 0) {
        yield chunk;
        chunk = "";
      }
    }
    if (chunk) yield chunk;
  }
  await pipeline(Readable.from(chunks()), fs.createWriteStream(file));
}

export async function totalFromCsv(file: string): Promise<Decimal> {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let total = ZERO_DECIMAL;
  let header = true;
  try {
    for await (const line of lines) {
      if (header) {
        header = false;
        continue;
      }
      const fields = line.split(",");
      total = add(total, mul(dec(fields[5]), dec(fields[6])));
    }
    return total;
  } finally {
    lines.close();
    input.destroy();
  }
}

async function main() {
  const rows = process.argv[2] === undefined ? 1_000_000 : Number(process.argv[2]);
  if (!Number.isSafeInteger(rows) || rows <= 0 || process.argv.length > 3) {
    throw new Error("Rows must be a positive safe integer.");
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-benchmark-"));
  const previousFolder = process.env.TOHYEE_ANALYTICS_DIR;
  process.env.TOHYEE_ANALYTICS_DIR = folder;
  const org = "benchmark";
  const file = path.join(folder, "sales.csv");
  let peakRss = process.memoryUsage().rss;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const timer = setInterval(sample, 10);
  const timings: string[] = [];
  async function time<T>(name: string, work: () => Promise<T>, count: (result: T) => number): Promise<T> {
    const started = performance.now();
    const result = await work();
    sample();
    timings.push(`| ${name} | ${Math.round(performance.now() - started)} | ${count(result)} |`);
    return result;
  }
  try {
    await time("Write seeded CSV", () => writeSalesCsv(file, rows), () => rows);
    const loaded = await time("Load CSV", () => loadCsv({
      organisationId: org, sourceFolder: folder, file, table: "sales", columns,
    }), (result) => result.rows);
    if (loaded.rows !== rows) throw new Error(`Expected ${rows} loaded rows, got ${loaded.rows}.`);
    for (const query of queries) {
      await time(query.name, () => queryAnalytics(org, query.sql), (result) => result.length);
    }
    const result = await time("DuckDB exact sales total", () => queryAnalytics(org,
      "select sum(quantity * unit_price)::varchar as total from sales"), (result) => result.length);
    const expected = await time("Verify total from CSV text", () => totalFromCsv(file), () => rows);
    const actual = result[0]?.total;
    if (typeof actual !== "string" || cmp(dec(actual), expected) !== 0) {
      throw new Error(`Sales total mismatch: DuckDB ${String(actual)}, CSV ${toFixedString(expected, 2)}.`);
    }
    await closeAnalytics(org);
    sample();
    const table = [
      `### Analytics benchmark (${process.platform}/${process.arch}, Node ${process.version}, seed 353)`,
      "",
      "| Measurement | Time (ms) | Rows / bytes |",
      "|---|---:|---:|",
      ...timings,
      `| CSV size (bytes) | — | ${fs.statSync(file).size} |`,
      `| DuckDB size (bytes) | — | ${fs.statSync(analyticsFilePath(org)).size} |`,
      `| Peak sampled RSS (bytes) | — | ${peakRss} |`,
      "",
      `Exact sales total: ${toFixedString(expected, 2)} (CSV and DuckDB match). RSS sampled every 10 ms and after each step.`,
      "",
    ].join("\n");
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  } finally {
    clearInterval(timer);
    await closeAnalytics(org);
    if (previousFolder === undefined) delete process.env.TOHYEE_ANALYTICS_DIR;
    else process.env.TOHYEE_ANALYTICS_DIR = previousFolder;
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
