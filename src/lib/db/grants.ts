import type pg from "pg";
import {
  getDatabaseUrl,
  hasSeparateAdminRole,
  usernameOf,
} from "@/lib/db/connection";
import { quoteSqlIdentifier } from "@/lib/db/sql";

/** Tables whose rows are posted history: the runtime login may only add rows. */
const APPEND_ONLY_TABLES = [
  "audit_events",
  "admin_audit_events",
  "ledger_journals",
  "ledger_journal_lines",
  "ledger_fx_revaluation_runs",
  "ledger_fx_revaluation_run_items",
  "inventory_movements",
  "gst_returns",
  "gst_return_adjustments",
  "gst_return_lines",
  "fixed_asset_depreciation_lines",
  "bank_reconciliation_splits",
  "ledger_foreign_opening_balances",
];

function quoteRole(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(role)) {
    throw new Error("The DATABASE_URL username can't be used as a role name.");
  }
  return `"${role.replace(/"/g, '""')}"`;
}

/**
 * When DATABASE_ADMIN_URL is a different login from DATABASE_URL, the admin
 * login owns every table and the runtime login only gets the data access it
 * needs: no DDL, no schema creation, and no UPDATE/DELETE on posted history.
 * With a single login this is a no-op (the append-only triggers still apply).
 */
export async function grantRuntimeAccess(
  client: pg.ClientBase,
  databaseName: string,
): Promise<void> {
  if (!hasSeparateAdminRole()) {
    return;
  }
  const runtime = quoteRole(usernameOf(getDatabaseUrl()));
  const database = quoteSqlIdentifier(databaseName);

  await client.query(`revoke connect, temporary on database ${database} from public`);
  await client.query(`grant connect on database ${database} to ${runtime}`);
  await client.query(`grant usage on schema public to ${runtime}`);
  await client.query(
    `grant select, insert, update, delete on all tables in schema public to ${runtime}`,
  );
  await client.query(`grant usage, select on all sequences in schema public to ${runtime}`);
  await client.query(`revoke all on table schema_migrations from ${runtime}`);
  await client.query(`grant select on table schema_migrations to ${runtime}`);

  const existing = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])`,
    [APPEND_ONLY_TABLES],
  );
  for (const row of existing.rows) {
    await client.query(`revoke update, delete, truncate on table ${row.table_name} from ${runtime}`);
  }
}

/**
 * Stops other database logins on the server from connecting to an
 * organisation database. Harmless in single-login mode (the owner keeps access).
 */
export async function restrictDatabaseConnect(
  client: pg.ClientBase,
  databaseName: string,
): Promise<void> {
  await client.query(
    `revoke connect, temporary on database ${quoteSqlIdentifier(databaseName)} from public`,
  );
}
