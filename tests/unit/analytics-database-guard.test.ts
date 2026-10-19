import { describe, expect, it } from "vitest";
import { checkReadOnlyQuery } from "@/lib/analytics/databases/guard";

/** The check on typed queries for database sources (decision 603). */
describe("checkReadOnlyQuery", () => {
  it("accepts one SELECT or WITH query and drops a final semicolon", () => {
    expect(checkReadOnlyQuery("select id, total from orders;", "postgres")).toBe("select id, total from orders");
    expect(checkReadOnlyQuery("  SELECT 1  ;;  ", "mysql")).toBe("SELECT 1");
    expect(checkReadOnlyQuery("with recent as (select * from orders where placed > '2026-01-01') select * from recent", "postgres")).toContain("with recent");
    expect(checkReadOnlyQuery("(select 1) union all (select 2)", "postgres")).toBe("(select 1) union all (select 2)");
  });

  it("ignores forbidden words inside strings and quoted names", () => {
    expect(() => checkReadOnlyQuery(`select 'delete me; drop table x' as note, "update" from t`, "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery("select `insert`, 'it''s set' from t", "mysql")).not.toThrow();
    expect(() => checkReadOnlyQuery("select [delete], [order]]x] from dbo.t", "sqlserver")).not.toThrow();
    expect(() => checkReadOnlyQuery("select $$drop table x$$, $tag$ insert $tag$", "postgres")).not.toThrow();
    // PostgreSQL's E'' strings and MySQL's strings use backslash escapes.
    expect(() => checkReadOnlyQuery(String.raw`select E'it\'s; delete' from t`, "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery(String.raw`select 'it\'s; delete' from t`, "mysql")).not.toThrow();
  });

  it("removes comments, so what is checked is what runs", () => {
    expect(checkReadOnlyQuery("select 1 -- drop table x\n, 2", "postgres")).toBe("select 1  \n, 2");
    expect(checkReadOnlyQuery("select /* update */ 1", "sqlserver")).toBe("select   1");
    expect(checkReadOnlyQuery("select 1 # delete\n", "mysql")).toBe("select 1");
    // MySQL would run the contents of /*! ... */, so they're dropped, not trusted.
    expect(checkReadOnlyQuery("select 1 /*!50000 , sleep(1) */", "mysql")).toBe("select 1");
    // PostgreSQL's comments nest.
    expect(checkReadOnlyQuery("select /* a /* b */ c */ 1", "postgres")).toBe("select   1");
  });

  it("refuses anything that isn't a single SELECT", () => {
    for (const sql of [
      "delete from orders",
      "update orders set total = 0",
      "insert into orders values (1)",
      "drop table orders",
      "truncate orders",
      "exec sp_who",
      "call refresh()",
      "show tables",
      "values (1)",
      "",
      "   ",
    ]) {
      expect(() => checkReadOnlyQuery(sql, "postgres"), sql).toThrow();
    }
    expect(() => checkReadOnlyQuery("select 1; select 2", "postgres")).toThrow(/one query/);
    expect(() => checkReadOnlyQuery("select 1; delete from t", "mysql")).toThrow(/one query/);
  });

  it("refuses writing words anywhere, including SQL Server batches without semicolons", () => {
    expect(() => checkReadOnlyQuery("select 1 delete from orders", "sqlserver")).toThrow(/DELETE/);
    expect(() => checkReadOnlyQuery("with d as (delete from t returning *) select * from d", "postgres")).toThrow(/DELETE/);
    expect(() => checkReadOnlyQuery("select * into backup_orders from orders", "sqlserver")).toThrow(/INTO/);
    expect(() => checkReadOnlyQuery("select * from orders into outfile '/tmp/x'", "mysql")).toThrow(/INTO/);
    expect(() => checkReadOnlyQuery("select * from orders for update", "postgres")).toThrow(/UPDATE/);
    expect(() => checkReadOnlyQuery("select * from orders for share", "postgres")).toThrow(/lock rows/);
    expect(() => checkReadOnlyQuery("select * from orders lock in share mode", "mysql")).toThrow(/LOCK/);
    expect(() => checkReadOnlyQuery("select 1 waitfor delay '00:00:10'", "sqlserver")).toThrow(/WAITFOR/);
    expect(() => checkReadOnlyQuery("select * from openrowset('SQLNCLI', 'x', 'select 1')", "sqlserver")).toThrow(/OPENROWSET/);
  });

  it("refuses functions that change data, read the server's files or reach other servers", () => {
    expect(() => checkReadOnlyQuery("select nextval('orders_id_seq')", "postgres")).toThrow(/nextval/);
    expect(() => checkReadOnlyQuery("select pg_read_file('/etc/passwd')", "postgres")).toThrow(/pg_read_file/);
    expect(() => checkReadOnlyQuery("select pg_advisory_lock(1)", "postgres")).toThrow(/pg_advisory_lock/);
    expect(() => checkReadOnlyQuery("select * from dblink('host=x', 'select 1') as t(a int)", "postgres")).toThrow(/dblink/);
    expect(() => checkReadOnlyQuery("select lo_import('/etc/passwd')", "postgres")).toThrow(/lo_import/);
    expect(() => checkReadOnlyQuery("select load_file('/etc/passwd')", "mysql")).toThrow(/load_file/);
    expect(() => checkReadOnlyQuery("select PG_TERMINATE_BACKEND (1)", "postgres")).toThrow(/pg_terminate_backend/);
    // The same names as plain columns are fine.
    expect(() => checkReadOnlyQuery("select nextval, lo_value from t", "postgres")).not.toThrow();
  });

  it("refuses unclosed quotes, comments and brackets", () => {
    expect(() => checkReadOnlyQuery("select 'abc", "postgres")).toThrow(/quote/);
    expect(() => checkReadOnlyQuery("select [abc", "sqlserver")).toThrow(/quote/);
    expect(() => checkReadOnlyQuery("select 1 /* open", "mysql")).toThrow(/comment/);
    expect(() => checkReadOnlyQuery("select (1", "postgres")).toThrow(/\)/);
    expect(() => checkReadOnlyQuery("select 1)", "postgres")).toThrow(/\(/);
    expect(() => checkReadOnlyQuery("select $x$ open", "postgres")).toThrow(/quote/);
  });

  it("refuses ORDER BY at the end for SQL Server, which can't wrap it, but not inside", () => {
    expect(() => checkReadOnlyQuery("select * from t order by id", "sqlserver")).toThrow(/ORDER BY/);
    expect(() => checkReadOnlyQuery("select row_number() over (order by id) as n from t", "sqlserver")).not.toThrow();
    expect(() => checkReadOnlyQuery("select * from t order by id", "postgres")).not.toThrow();
  });

  it("limits the length", () => {
    expect(() => checkReadOnlyQuery(`select ${"1, ".repeat(10_000)}1`, "postgres")).toThrow(/20,000/);
  });
});
