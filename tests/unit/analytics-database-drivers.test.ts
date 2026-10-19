import net from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseConnectionSettings } from "@/lib/analytics/databases/config";
import { readSourceRows, testConnection } from "@/lib/analytics/databases/connections";
import {
  type DriverModules,
  friendlyError,
  type MssqlModule,
  type MysqlField,
  type MysqlModule,
  openSession,
  type PgModule,
  sqlServerConnector,
} from "@/lib/analytics/databases/drivers";

/**
 * The database drivers' code paths (decisions 602-605). MySQL and SQL Server
 * servers aren't available here, so these use fakes that stand in for the
 * mysql2 and mssql modules and record what Tohyee asks of them. They show
 * what Tohyee sends; they don't show that a real MySQL or SQL Server
 * accepts it. PostgreSQL is tested for real in
 * tests/integration/analytics-databases.test.ts.
 */

const options = { timeoutMs: 5_000, connectTimeoutMs: 1_000, timeZone: "Pacific/Auckland" };
const unused = async () => {
  throw new Error("not this driver");
};

function fakeMysql(rows: unknown[][], fields: MysqlField[]) {
  const calls: string[] = [];
  const configs: Record<string, unknown>[] = [];
  const driver: MysqlModule = {
    async createConnection(config) {
      configs.push(config);
      return {
        async query({ sql }) {
          calls.push(sql);
          if (sql.startsWith("set session max_execution_time")) throw Object.assign(new Error("Unknown system variable"), { errno: 1193 });
          if (sql.includes("information_schema.tables")) return [[["orders", "BASE TABLE"], ["order_totals", "VIEW"]], undefined];
          if (sql.startsWith("select * from (")) return [[], fields];
          return [[], undefined];
        },
        async end() {
          calls.push("(end)");
        },
        connection: {
          query({ sql }) {
            calls.push(sql);
            return { stream: () => Readable.from(rows) };
          },
        },
      };
    },
  };
  return { module: driver, calls, configs };
}

const mysqlFields: MysqlField[] = [
  { name: "id", columnType: 0x03, columnLength: 11, decimals: 0, flags: 0, characterSet: 63 },
  { name: "total", columnType: 0xf6, columnLength: 12, decimals: 2, flags: 0, characterSet: 63 },
  { name: "paid", columnType: 0x01, columnLength: 1, decimals: 0, flags: 0, characterSet: 63 },
  { name: "flags", columnType: 0x10, columnLength: 1, decimals: 0, flags: 0, characterSet: 63 },
  { name: "photo", columnType: 0xfc, columnLength: 65535, decimals: 0, flags: 0, characterSet: 63 },
  { name: "notes", columnType: 0xfc, columnLength: 65535, decimals: 0, flags: 0, characterSet: 224 },
  { name: "placed", columnType: 0x0c, columnLength: 19, decimals: 0, flags: 0, characterSet: 63 },
];

const mysqlSettings = parseConnectionSettings({ engine: "mysql", host: "192.168.1.30", database: "shop", username: "reader", encryption: "require" });

describe("MySQL (with a fake mysql2; not tried against a real server)", () => {
  it("connects read only, without local files or several statements, and reads exact text", async () => {
    const fake = fakeMysql([], mysqlFields);
    const session = await openSession(mysqlSettings, "s3cret", options, { pg: unused, mssql: unused, mysql: async () => fake.module });
    const config = fake.configs[0];
    expect(config).toMatchObject({
      host: "192.168.1.30",
      port: 3306,
      database: "shop",
      user: "reader",
      password: "s3cret",
      flags: "-LOCAL_FILES",
      multipleStatements: false,
      decimalNumbers: false,
      bigNumberStrings: true,
      dateStrings: true,
      ssl: { rejectUnauthorized: false },
    });
    expect(fake.calls[0]).toBe("set session transaction read only");
    // MySQL's own statement limit, falling back to MariaDB's name.
    expect(fake.calls[1]).toBe("set session max_execution_time = 5000");
    expect(fake.calls[2]).toBe("set session max_statement_time = 5");

    expect(await session.objects()).toEqual([
      { schema: null, name: "orders", kind: "table" },
      { schema: null, name: "order_totals", kind: "view" },
    ]);
    const described = await session.describe("select * from `orders`");
    expect(described.map((column) => [column.name, column.type, column.scale, column.binary ?? false])).toEqual([
      ["id", "long", null, false],
      ["total", "newdecimal", 2, false],
      ["paid", "tiny", null, false],
      ["flags", "bit", null, false],
      ["photo", "blob", null, true],
      ["notes", "blob", null, false],
      ["placed", "datetime", null, false],
    ]);
    // Each look happens inside a read-only transaction.
    const describeAt = fake.calls.findIndex((sql) => sql.startsWith("select * from ("));
    expect(fake.calls[describeAt - 1]).toBe("start transaction read only");
    expect(fake.calls[describeAt + 1]).toBe("rollback");
    await session.close();
    expect(fake.calls.at(-1)).toBe("(end)");
  });

  it("doesn't encrypt when told not to, and checks certificates when told to", async () => {
    const off = fakeMysql([], mysqlFields);
    await (await openSession({ ...mysqlSettings, encryption: "off" }, "x", options, { pg: unused, mssql: unused, mysql: async () => off.module })).close();
    expect(off.configs[0].ssl).toBeUndefined();
    const verify = fakeMysql([], mysqlFields);
    await (await openSession({ ...mysqlSettings, encryption: "verify" }, "x", options, { pg: unused, mssql: unused, mysql: async () => verify.module })).close();
    expect(verify.configs[0].ssl).toEqual({ rejectUnauthorized: true });
  });

  it("loads chosen columns through Tohyee's outer SELECT, a batch at a time, inside a read-only transaction", async () => {
    const fake = fakeMysql(
      [
        [1, "12.50", 1, "1", "2026-03-01 09:30:00"],
        [2, "0.10", 0, "0", "0000-00-00 00:00:00"],
      ],
      mysqlFields,
    );
    const drivers: DriverModules = { pg: unused, mssql: unused, mysql: async () => fake.module };
    const reading = await readSourceRows({
      settings: mysqlSettings,
      password: "s3cret",
      spec: { schema: null, table: "orders" },
      columns: [
        { source: "id", name: "id", kind: "integer" },
        { source: "total", name: "total", kind: "money" },
        { source: "paid", name: "paid", kind: "boolean" },
        { source: "flags", name: "flags", kind: "boolean" },
        { source: "placed", name: "placed", kind: "timestamp" },
      ],
      rowLimit: 10,
      drivers,
    });
    const batches: Array<Array<string | null>[]> = [];
    for await (const batch of reading.batches) batches.push(batch);
    expect(batches).toEqual([
      [
        ["1", "12.50", "1", "1", "2026-03-01 09:30:00"],
        ["2", "0.10", "0", "0", null],
      ],
    ]);
    const select = fake.calls.find((sql) => sql.startsWith("select tohyee_q."));
    expect(select).toBe(
      "select tohyee_q.`id` as `id`, tohyee_q.`total` as `total`, tohyee_q.`paid` as `paid`, cast(tohyee_q.`flags` as unsigned) as `flags`, tohyee_q.`placed` as `placed` from (\nselect * from `orders`\n) as tohyee_q limit 11",
    );
    const at = fake.calls.indexOf(select!);
    expect(fake.calls[at - 1]).toBe("start transaction read only");
    expect(fake.calls).toContain("(end)");
  });

  it("stops past the row limit instead of loading part of the data", async () => {
    const fake = fakeMysql([[1], [2], [3]], mysqlFields);
    const reading = await readSourceRows({
      settings: mysqlSettings,
      password: "x",
      spec: { query: "select id from orders" },
      columns: [{ source: "id", name: "id", kind: "integer" }],
      rowLimit: 2,
      drivers: { pg: unused, mssql: unused, mysql: async () => fake.module },
    });
    await expect(async () => {
      for await (const batch of reading.batches) void batch;
    }).rejects.toThrow(/more than 2 rows/);
    expect(fake.calls.at(-1)).toBe("(end)");
  });

  it("refuses a column that has gone, or one that's binary", async () => {
    const fake = fakeMysql([], mysqlFields);
    const drivers = { pg: unused, mssql: unused, mysql: async () => fake.module };
    await expect(
      readSourceRows({ settings: mysqlSettings, password: "x", spec: { schema: null, table: "orders" }, columns: [{ source: "gone", name: "gone", kind: "text" }], rowLimit: 5, drivers }),
    ).rejects.toThrow(/gone isn't there any more/);
    await expect(
      readSourceRows({ settings: mysqlSettings, password: "x", spec: { schema: null, table: "orders" }, columns: [{ source: "photo", name: "photo", kind: "text" }], rowLimit: 5, drivers }),
    ).rejects.toThrow(/binary/);
    expect(fake.calls.filter((call) => call === "(end)")).toHaveLength(2);
  });

  it("checks a typed query before connecting to run it", async () => {
    const fake = fakeMysql([], mysqlFields);
    await expect(
      readSourceRows({
        settings: mysqlSettings,
        password: "x",
        spec: { query: "delete from orders" },
        columns: [{ source: "id", name: "id", kind: "integer" }],
        rowLimit: 5,
        drivers: { pg: unused, mssql: unused, mysql: async () => fake.module },
      }),
    ).rejects.toThrow(/Only SELECT/);
    expect(fake.calls.some((sql) => sql.includes("delete"))).toBe(false);
  });
});

function fakeMssql(rows: unknown[][]) {
  const queries: string[] = [];
  const configs: Record<string, unknown>[] = [];
  let closed = false;
  class ConnectionPool {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    async connect() {
      return this;
    }
    request() {
      let streamed: (Readable & { destroy(error?: Error): Readable }) | null = null;
      return {
        arrayRowMode: null as boolean | null,
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("information_schema.tables")) return { recordset: [["dbo", "Orders", "BASE TABLE"], ["sales", "Totals", "VIEW"]] };
          if (sql.startsWith("select top (0)")) {
            return {
              columns: [
                [
                  { name: "OrderID", type: { declaration: "int" } },
                  { name: "Amount", type: { declaration: "decimal" }, precision: 18, scale: 2 },
                  { name: "Fee", type: { declaration: "money" }, precision: 19, scale: 4 },
                  { name: "Placed", type: { declaration: "datetimeoffset" } },
                  { name: "Paid", type: { declaration: "bit" } },
                  { name: "Scan", type: { declaration: "varbinary" } },
                  { name: "Where", type: { declaration: "udt" }, udt: { name: "geography" } },
                ],
              ],
            };
          }
          return {};
        },
        toReadableStream() {
          streamed = Readable.from(rows) as Readable & { destroy(error?: Error): Readable };
          return streamed;
        },
      };
    }
    async close() {
      closed = true;
    }
  }
  return { module: { ConnectionPool } as unknown as MssqlModule, queries, configs, closed: () => closed };
}

const sqlServer = parseConnectionSettings({ engine: "sqlserver", host: "OFFICE-PC\\SQLEXPRESS", database: "Sales", username: "reader", encryption: "require" });

describe("SQL Server (with a fake mssql; not tried against a real server)", () => {
  it("connects to the named instance, trusting its certificate only when chosen, through Tohyee's own connector", async () => {
    const fake = fakeMssql([]);
    const session = await openSession(sqlServer, "s3cret", options, { pg: unused, mysql: unused, mssql: async () => fake.module });
    const config = fake.configs[0] as { options: Record<string, unknown> } & Record<string, unknown>;
    expect(config).toMatchObject({ server: "OFFICE-PC", port: undefined, database: "Sales", user: "reader", password: "s3cret", requestTimeout: 5_000, pool: { max: 1, min: 0 } });
    expect(config.options).toMatchObject({ encrypt: true, trustServerCertificate: true, instanceName: "SQLEXPRESS" });
    expect(typeof config.options.connector).toBe("function");
    await session.close();
    expect(fake.closed()).toBe(true);

    const verify = fakeMssql([]);
    await (await openSession({ ...sqlServer, encryption: "verify", instanceName: null, port: 1433 }, "x", options, { pg: unused, mysql: unused, mssql: async () => verify.module })).close();
    expect(verify.configs[0]).toMatchObject({ port: 1433, options: { encrypt: true, trustServerCertificate: false } });
    const off = fakeMssql([]);
    await (await openSession({ ...sqlServer, encryption: "off" }, "x", options, { pg: unused, mysql: unused, mssql: async () => off.module })).close();
    expect(off.configs[0]).toMatchObject({ options: { encrypt: false } });
  });

  it("lists tables and views and maps column types, leaving binary data out", async () => {
    const fake = fakeMssql([]);
    const session = await openSession(sqlServer, "x", options, { pg: unused, mysql: unused, mssql: async () => fake.module });
    expect(await session.objects()).toEqual([
      { schema: "dbo", name: "Orders", kind: "table" },
      { schema: "sales", name: "Totals", kind: "view" },
    ]);
    const columns = await session.describe("select * from [dbo].[Orders]");
    expect(columns.map((column) => [column.name, column.type, column.scale])).toEqual([
      ["OrderID", "int", null],
      ["Amount", "decimal", 2],
      ["Fee", "money", null],
      ["Placed", "datetimeoffset", null],
      ["Paid", "bit", null],
      ["Scan", "varbinary", null],
      ["Where", "geography", null],
    ]);
    await session.close();
  });

  it("selects decimals and money as exact text and dates without offsets, with TOP for the limit", async () => {
    const fake = fakeMssql([[7, "1234567890123.45", "12.3400", "2026-03-01 09:30:00.1234567", "1"]]);
    const reading = await readSourceRows({
      settings: sqlServer,
      password: "x",
      spec: { schema: "dbo", table: "Orders" },
      columns: [
        { source: "OrderID", name: "order_id", kind: "integer" },
        { source: "Amount", name: "amount", kind: "money" },
        { source: "Fee", name: "fee", kind: "quantity" },
        { source: "Placed", name: "placed", kind: "timestamp" },
        { source: "Paid", name: "paid", kind: "boolean" },
      ],
      rowLimit: 100,
      drivers: { pg: unused, mysql: unused, mssql: async () => fake.module },
    });
    const rows: Array<string | null>[] = [];
    for await (const batch of reading.batches) rows.push(...batch);
    expect(rows).toEqual([["7", "1234567890123.45", "12.3400", "2026-03-01 09:30:00.1234567", "1"]]);
    expect(fake.queries.at(-1)).toBe(
      "select top (101) tohyee_q.[OrderID] as [OrderID], convert(varchar(64), tohyee_q.[Amount]) as [Amount], convert(varchar(64), tohyee_q.[Fee], 2) as [Fee], " +
        "convert(varchar(27), convert(datetime2, tohyee_q.[Placed]), 121) as [Placed], convert(varchar(1), tohyee_q.[Paid]) as [Paid] from (\nselect * from [dbo].[Orders]\n) as tohyee_q",
    );
    expect(fake.closed()).toBe(true);
  });

  it("refuses to follow a redirect to another server", async () => {
    const connector = sqlServerConnector("office-pc");
    const refused = await connector({ host: "elsewhere.example.com", port: 1433 }, undefined).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("TOHYEE_REDIRECT");
    expect(friendlyError("sqlserver", { code: "ESOCKET", message: "Connection lost", originalError: refused }, "connect", sqlServer, 15_000).message).toMatch(/somewhere else/);

    // The server that was entered is connected to as normal.
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const socket = await sqlServerConnector("127.0.0.1")({ host: "127.0.0.1", port }, undefined);
    expect(socket.remotePort).toBe(port);
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
});

describe("PostgreSQL session settings (with a fake pg; the real server is in the integration tests)", () => {
  it("makes the whole session read only and reads every value as the server's text", async () => {
    const configs: Record<string, unknown>[] = [];
    const sent: string[] = [];
    class Client {
      constructor(config: Record<string, unknown>) {
        configs.push(config);
      }
      async connect() {}
      async query(query: string | { text: string }) {
        sent.push(typeof query === "string" ? query : query.text);
        return { rows: [], fields: [] };
      }
      async end() {}
      on() {}
    }
    const pg = { Client } as unknown as PgModule;
    const settings = parseConnectionSettings({ engine: "postgres", host: "10.0.0.5", database: "shop", username: "reader", encryption: "off" });
    const session = await openSession(settings, "x", options, { mysql: unused, mssql: unused, pg: async () => pg });
    expect(configs[0]).toMatchObject({ host: "10.0.0.5", port: 5432, ssl: false, statement_timeout: 5_000, application_name: "Tohyee analytics" });
    expect(configs[0].options).toBe("-c default_transaction_read_only=on -c TimeZone=Pacific/Auckland -c DateStyle=ISO");
    const parser = (configs[0].types as { getTypeParser: (oid: number) => (value: string) => unknown }).getTypeParser(1700);
    expect(parser("12345678901234567890.12")).toBe("12345678901234567890.12");
    await session.describe('select * from "orders"');
    expect(sent.slice(0, 3)).toEqual(["begin", "set transaction read only", 'select * from (\nselect * from "orders"\n) as tohyee_q limit 0']);
    expect(sent.at(-1)).toBe("rollback");
  });
});

describe("plain error messages", () => {
  const settings = { host: "db.office", port: 5432, database: "shop", username: "reader" };
  const message = (engine: "postgres" | "mysql" | "sqlserver", error: unknown, stage: "connect" | "query" = "connect") =>
    friendlyError(engine, error, stage, settings, 30_000).message;

  it("says what kind of connection failure it was, without the driver's text", () => {
    expect(message("postgres", { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND db.office" })).toMatch(/couldn't find a server called db.office/);
    const refused = message("sqlserver", { code: "ESOCKET", message: "Failed to connect to 10.1.2.3:1433 - connect ECONNREFUSED 10.1.2.3:1433", originalError: { code: "ECONNREFUSED" } });
    expect(refused).toMatch(/Nothing answered at db.office \(port 5432\)/);
    expect(refused).not.toContain("10.1.2.3");
    expect(message("mysql", { code: "EHOSTUNREACH" })).toMatch(/can't reach/);
    expect(message("sqlserver", { code: "EINSTLOOKUP", message: "Failed to get response from SQL Server Browser" })).toMatch(/SQL Server Browser/);
    expect(message("postgres", { message: "Connection terminated due to connection timeout" })).toMatch(/didn't answer within 30 seconds/);
  });

  it("explains logins, missing databases and encryption", () => {
    expect(message("postgres", { code: "28P01", message: 'password authentication failed for user "reader"' })).toBe("The user name or password wasn't accepted for reader.");
    expect(message("postgres", { code: "28000", message: 'no pg_hba.conf entry for host "10.0.0.9", user "reader"' })).toMatch(/pg_hba.conf/);
    expect(message("mysql", { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 })).toMatch(/wasn't accepted/);
    expect(message("sqlserver", { code: "ELOGIN", message: "Login failed for user 'reader'." })).toMatch(/wasn't accepted/);
    expect(message("sqlserver", { code: "ELOGIN", message: 'Cannot open database "shop" requested by the login.' })).toMatch(/no database called shop/);
    expect(message("postgres", { code: "3D000", message: 'database "shop" does not exist' })).toMatch(/no database called shop/);
    expect(message("mysql", { code: "ER_BAD_DB_ERROR", errno: 1049 })).toMatch(/no database called shop/);
    expect(message("postgres", { message: "The server does not support SSL connections" })).toMatch(/doesn't use encryption/);
    expect(message("mysql", { code: "HANDSHAKE_NO_SSL_SUPPORT" })).toMatch(/doesn't use encryption/);
    expect(message("sqlserver", { code: "ESOCKET", originalError: { code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "self-signed certificate" } })).toMatch(/certificate couldn't be checked/);
  });

  it("passes on the database's first line about a query, and refusals to write", () => {
    expect(message("postgres", { code: "42P01", message: 'relation "nope" does not exist' }, "query")).toBe('The query didn\'t work. The database said: relation "nope" does not exist');
    expect(message("postgres", { code: "57014", message: "canceling statement due to statement timeout" }, "query")).toMatch(/more than 30 seconds/);
    expect(message("mysql", { errno: 3024, message: "Query execution was interrupted, maximum statement execution time exceeded" }, "query")).toMatch(/more than 30 seconds/);
    expect(message("postgres", { code: "25006", message: "cannot execute INSERT in a read-only transaction" }, "query")).toMatch(/only reads/);
    expect(message("mysql", { errno: 1792, message: "Cannot execute statement in a READ ONLY transaction." }, "query")).toMatch(/only reads/);
  });

  it("doesn't mistake a query's error about a column for a connection problem", () => {
    expect(message("postgres", { code: "42703", message: 'column "timeout" does not exist' }, "query")).toBe('The query didn\'t work. The database said: column "timeout" does not exist');
    expect(message("postgres", { code: "42703", message: 'column "encrypted_ssl" does not exist' }, "query")).toMatch(/^The query didn't work/);
    expect(message("sqlserver", { code: "ESOCKET", originalError: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })).toMatch(/Encrypt, trust the server's certificate/);
  });

  it("never repeats an unknown connection error's text", () => {
    const text = message("postgres", { message: "internal: host=10.9.9.9 password=hunter2" });
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("10.9.9.9");
    expect(text).toMatch(/couldn't connect to the PostgreSQL database/);
  });

  it("reports a failed connection test plainly", async () => {
    const failing: DriverModules = {
      pg: unused,
      mssql: unused,
      mysql: async () => ({
        createConnection: async () => {
          throw Object.assign(new Error("Access denied for user 'reader'@'10.0.0.2' (using password: YES)"), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 });
        },
      }),
    };
    await expect(testConnection(mysqlSettings, "wrong", failing)).rejects.toThrow("The user name or password wasn't accepted for reader.");
  });
});
