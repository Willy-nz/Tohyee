import type pg from "pg";
import { getCorePool } from "@/lib/db/pools";

export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

/** The only way services talk to a database: parameterised queries. */
export type DbClient = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

export function wrapClient(client: pg.ClientBase): DbClient {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const result = await client.query(sql, params ? [...params] : []);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
  };
}

const STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Runs `work` inside one transaction on a pooled connection. Everything the
 * work does commits together or not at all.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await work(wrapClient(client));
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is unusable; discard it instead of returning it to the pool.
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

export function withCoreTransaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
  return withTransaction(getCorePool(), work);
}

/** Single query on the core database outside an explicit transaction. */
export async function coreQuery<T = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  const result = await getCorePool().query(sql, params ? [...params] : []);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}
