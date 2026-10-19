import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROW_LIMIT,
  describeConnection,
  parseConnectionSettings,
  parsePassword,
  parseRowLimit,
  sameDestination,
} from "@/lib/analytics/databases/config";
import {
  outerSelect,
  describeSelect,
  quoteName,
  quoteObject,
  selectExpression,
  snakeName,
  suggestColumn,
  tableNameFor,
  valueText,
} from "@/lib/analytics/databases/types";
import { columnNameFrom } from "@/lib/analytics/engine";
import { fieldLabel } from "@/lib/analytics/labels";

const base = { engine: "postgres", host: "192.168.1.20", database: "shop", username: "reader" };

describe("database connection settings (decision 602)", () => {
  it("takes a server name or address, with each database's default port", () => {
    expect(parseConnectionSettings(base)).toEqual({ engine: "postgres", host: "192.168.1.20", port: 5432, database: "shop", username: "reader", encryption: "require", instanceName: null });
    expect(parseConnectionSettings({ ...base, engine: "mysql", host: "db.office.local" }).port).toBe(3306);
    expect(parseConnectionSettings({ ...base, engine: "sqlserver", host: "OFFICE-PC" }).port).toBe(1433);
    expect(parseConnectionSettings({ ...base, port: "6543" }).port).toBe(6543);
    expect(parseConnectionSettings({ ...base, host: "fe80::1" }).host).toBe("fe80::1");
    expect(parseConnectionSettings({ ...base, host: "[::1]" }).host).toBe("::1");
  });

  it("splits SERVER\\INSTANCE for SQL Server, and leaves the port to SQL Server Browser", () => {
    const named = parseConnectionSettings({ ...base, engine: "sqlserver", host: "OFFICE-PC\\SQLEXPRESS" });
    expect(named).toMatchObject({ host: "OFFICE-PC", instanceName: "SQLEXPRESS", port: null });
    expect(parseConnectionSettings({ ...base, engine: "sqlserver", host: "OFFICE-PC", instanceName: "SQLEXPRESS", port: 1435 })).toMatchObject({ instanceName: "SQLEXPRESS", port: 1435 });
    expect(() => parseConnectionSettings({ ...base, engine: "sqlserver", host: "OFFICE-PC\\A", instanceName: "B" })).toThrow(/twice/);
    expect(() => parseConnectionSettings({ ...base, host: "pc\\inst" })).toThrow();
    expect(() => parseConnectionSettings({ ...base, instanceName: "SQLEXPRESS" })).not.toThrow();
    expect(parseConnectionSettings({ ...base, instanceName: "SQLEXPRESS" }).instanceName).toBeNull();
    expect(() => parseConnectionSettings({ ...base, engine: "sqlserver", host: "pc", instanceName: "bad name!" })).toThrow(/instance name/);
  });

  it("refuses web addresses, ports in the name and other junk", () => {
    for (const host of ["http://db", "db:5432", "user@db", "db/path", "db name", "", "-db", "a".repeat(254)]) {
      expect(() => parseConnectionSettings({ ...base, host }), host).toThrow();
    }
    for (const port of [0, 65536, "abc", 1.5, -1]) {
      expect(() => parseConnectionSettings({ ...base, port }), String(port)).toThrow(/port/);
    }
    expect(() => parseConnectionSettings({ ...base, engine: "oracle" })).toThrow(/SQL Server, PostgreSQL or MySQL/);
    expect(() => parseConnectionSettings({ ...base, encryption: "maybe" })).toThrow(/encrypted/);
    expect(() => parseConnectionSettings({ ...base, database: "" })).toThrow(/database name/);
    expect(() => parseConnectionSettings({ ...base, username: "a\nb" })).toThrow(/one line/);
  });

  it("keeps passwords exactly as typed", () => {
    expect(parsePassword("  spaced  ", true)).toBe("  spaced  ");
    expect(parsePassword("", false)).toBeNull();
    expect(() => parsePassword("", true)).toThrow(/password/);
    expect(() => parsePassword("x".repeat(1025), true)).toThrow();
  });

  it("knows when a saved password would go somewhere else", () => {
    const saved = parseConnectionSettings(base);
    expect(sameDestination(saved, parseConnectionSettings({ ...base, host: "192.168.1.20", encryption: "verify" }))).toBe(true);
    expect(sameDestination(saved, parseConnectionSettings({ ...base, host: "evil.example.com" }))).toBe(false);
    expect(sameDestination(saved, parseConnectionSettings({ ...base, port: 5433 }))).toBe(false);
    expect(sameDestination(saved, parseConnectionSettings({ ...base, username: "admin" }))).toBe(false);
    expect(sameDestination(saved, parseConnectionSettings({ ...base, database: "other" }))).toBe(false);
  });

  it("limits rows", () => {
    expect(parseRowLimit(undefined)).toBe(DEFAULT_ROW_LIMIT);
    expect(parseRowLimit("250")).toBe(250);
    expect(() => parseRowLimit(0)).toThrow();
    expect(() => parseRowLimit(5_000_001)).toThrow(/5,000,000/);
  });

  it("describes where a connection points", () => {
    expect(describeConnection({ host: "pc", port: null, instanceName: "SQLEXPRESS", database: "Sales" })).toBe("pc\\SQLEXPRESS › Sales");
    expect(describeConnection({ host: "10.0.0.5", port: 5432, instanceName: null, database: "shop" })).toBe("10.0.0.5:5432 › shop");
  });
});

describe("database column types into DuckDB (decision 605)", () => {
  const column = (type: string, extra: Partial<{ name: string; precision: number | null; scale: number | null; binary: boolean; length: number }> = {}) => ({
    name: extra.name ?? "col",
    type,
    precision: extra.precision ?? null,
    scale: extra.scale ?? null,
    binary: extra.binary,
    length: extra.length,
  });

  it("keeps exact decimals exact: up to two places is money", () => {
    expect(suggestColumn("postgres", column("numeric", { precision: 12, scale: 2 })).kind).toBe("money");
    expect(suggestColumn("postgres", column("money")).kind).toBe("money");
    expect(suggestColumn("sqlserver", column("money")).kind).toBe("money");
    expect(suggestColumn("sqlserver", column("decimal", { precision: 18, scale: 2 })).kind).toBe("money");
    expect(suggestColumn("mysql", column("newdecimal", { precision: 10, scale: 2 })).kind).toBe("money");
    expect(suggestColumn("postgres", column("numeric", { name: "qty", precision: 10, scale: 3 })).kind).toBe("quantity");
    expect(suggestColumn("postgres", column("numeric", { precision: 10, scale: 5 })).kind).toBe("decimal");
    expect(suggestColumn("postgres", column("numeric", { precision: 10, scale: 0 })).kind).toBe("integer");
    expect(suggestColumn("postgres", column("numeric", { name: "total" })).kind).toBe("money");
    expect(suggestColumn("postgres", column("numeric")).kind).toBe("decimal");
    // Floating-point columns are already approximate at the source.
    expect(suggestColumn("mysql", column("double")).kind).toBe("decimal");
  });

  it("maps dates, date-times, yes/no and whole numbers", () => {
    expect(suggestColumn("postgres", column("date")).kind).toBe("date");
    expect(suggestColumn("postgres", column("timestamptz")).kind).toBe("timestamp");
    expect(suggestColumn("sqlserver", column("datetime2")).kind).toBe("timestamp");
    expect(suggestColumn("sqlserver", column("datetimeoffset")).kind).toBe("timestamp");
    expect(suggestColumn("mysql", column("datetime")).kind).toBe("timestamp");
    expect(suggestColumn("postgres", column("bool")).kind).toBe("boolean");
    expect(suggestColumn("sqlserver", column("bit")).kind).toBe("boolean");
    expect(suggestColumn("mysql", column("tiny", { length: 1 })).kind).toBe("boolean");
    expect(suggestColumn("mysql", column("tiny", { length: 4 })).kind).toBe("integer");
    expect(suggestColumn("mysql", column("bit", { length: 1 })).kind).toBe("boolean");
    expect(suggestColumn("postgres", column("int8")).kind).toBe("integer");
    expect(suggestColumn("sqlserver", column("bigint")).kind).toBe("integer");
    expect(suggestColumn("postgres", column("uuid")).kind).toBe("text");
    expect(suggestColumn("sqlserver", column("time")).kind).toBe("text");
  });

  it("won't load binary data", () => {
    expect(suggestColumn("postgres", column("bytea")).loadable).toBe(false);
    expect(suggestColumn("sqlserver", column("varbinary")).loadable).toBe(false);
    expect(suggestColumn("sqlserver", column("geography")).loadable).toBe(false);
    expect(suggestColumn("mysql", column("blob", { binary: true })).loadable).toBe(false);
    expect(suggestColumn("mysql", column("blob", { binary: false })).loadable).toBe(true);
    expect(suggestColumn("mysql", column("var_string", { binary: true })).loadable).toBe(false);
  });

  it("quotes names safely for each database", () => {
    expect(quoteName("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteName("mysql", "a`b")).toBe("`a``b`");
    expect(quoteName("sqlserver", "a]b")).toBe("[a]]b]");
    expect(quoteObject("sqlserver", "dbo", "Orders")).toBe("[dbo].[Orders]");
    expect(quoteObject("mysql", "shop", "orders")).toBe("`orders`");
  });

  it("selects SQL Server's decimals, money and dates as exact text", () => {
    expect(selectExpression("sqlserver", column("decimal", { precision: 18, scale: 2 }))).toBe("convert(varchar(64), tohyee_q.[col])");
    expect(selectExpression("sqlserver", column("money"))).toBe("convert(varchar(64), tohyee_q.[col], 2)");
    expect(selectExpression("sqlserver", column("datetimeoffset"))).toContain("convert(datetime2,");
    expect(selectExpression("postgres", column("money"))).toBe('(tohyee_q."col")::numeric');
    expect(selectExpression("mysql", column("bit"))).toBe("cast(tohyee_q.`col` as unsigned)");
    expect(selectExpression("postgres", column("numeric"))).toBe('tohyee_q."col"');
  });

  it("wraps the query in Tohyee's own SELECT with a row limit, on its own lines", () => {
    expect(outerSelect("postgres", "select 1 as col -- note", [column("int4")], 11)).toBe('select tohyee_q."col" as "col" from (\nselect 1 as col -- note\n) as tohyee_q limit 11');
    expect(outerSelect("sqlserver", "select 1 as col", [column("int")], 11)).toBe("select top (11) tohyee_q.[col] as [col] from (\nselect 1 as col\n) as tohyee_q");
    expect(describeSelect("mysql", "select 1")).toBe("select * from (\nselect 1\n) as tohyee_q limit 0");
    expect(describeSelect("sqlserver", "select 1")).toContain("top (0)");
  });

  it("turns values into text DuckDB converts", () => {
    expect(valueText("1234.56", "money")).toBe("1234.56");
    expect(valueText(12, "integer")).toBe("12");
    expect(valueText(BigInt(12), "integer")).toBe("12");
    expect(valueText(true, "boolean")).toBe("true");
    expect(valueText(null, "text")).toBeNull();
    expect(valueText(new Date("2026-03-01T09:30:00.000Z"), "timestamp")).toBe("2026-03-01 09:30:00.000");
    expect(valueText("2026-03-01 09:30:00+13", "timestamp")).toBe("2026-03-01 09:30:00");
    expect(valueText("2026-03-01 09:30:00.123456+13:00", "timestamp")).toBe("2026-03-01 09:30:00.123456");
    expect(valueText("0000-00-00", "date")).toBeNull();
    expect(valueText("0000-00-00 00:00:00", "timestamp")).toBeNull();
    expect(valueText(new Uint8Array([1, 2]), "text")).toBeNull();
    expect(valueText({ a: 1 }, "text")).toBe('{"a":1}');
  });

  it("gives tables and columns friendly names (#336)", () => {
    expect(snakeName("CustomerName")).toBe("Customer_Name");
    expect(tableNameFor("SalesOrders", [])).toBe("sales_orders");
    expect(tableNameFor("SalesOrders", ["sales_orders"])).toBe("sales_orders_2");
    expect(tableNameFor("2026 sales", [])).toBe("t_2026_sales");
    expect(tableNameFor("tohyee_invoices", [])).toBe("x_tohyee_invoices");
    const taken = new Set<string>();
    const name = columnNameFrom(snakeName("InvoiceGSTAmount"), taken);
    expect(name).toBe("invoice_gst_amount");
    expect(fieldLabel(name)).toBe("Invoice GST amount");
  });
});
