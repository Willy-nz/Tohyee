import { createHash } from "node:crypto";
import { coreQuery } from "@/lib/db/transactions";
import { requireId } from "@/lib/validation";

/**
 * The plan for moving a group's existing consolidation records out of the
 * core database into its steward's database (decision 646; Codex,
 * delegated by owner, 20 October 2026: "record and test a migration plan
 * before moving anything"). Nothing here writes. `planGroupRecordMove`
 * reads the records the core database holds for one group, maps each row
 * to the steward table it would go to, maps it back, and checks the round
 * trip loses nothing (same rows, same checksum). The move itself isn't
 * built; docs/ARCHITECTURE.md ("Moving a group's records") has the steps.
 */

type Table = {
  /** In the core database now (core migrations 0007 and 0008). */
  from: string;
  /** The steward table it would go to (not made yet). */
  to: string;
  /** Columns copied as they are; `group_id` stays the group's registry id. */
  columns: string[];
  where: string;
};

export const MOVE_TABLES: Table[] = [
  {
    from: "consolidation_rate_overrides",
    to: "group_rate_overrides",
    columns: ["group_id", "currency_code", "month", "kind", "rate", "reason", "changed_by_email", "changed_at"],
    where: "group_id = $1",
  },
  { from: "consolidation_budget_rates", to: "group_budget_rates", columns: ["group_id", "currency_code", "month", "rate", "changed_by_email", "changed_at"], where: "group_id = $1" },
  {
    from: "consolidation_adjustments",
    to: "group_adjustments",
    columns: ["id", "group_id", "adjustment_date", "description", "removed_at", "removed_by_email", "created_by_email", "created_at"],
    where: "group_id = $1",
  },
  {
    from: "consolidation_adjustment_lines",
    to: "group_adjustment_lines",
    columns: ["id", "adjustment_id", "line_order", "organisation_id", "account_code", "debit", "credit"],
    where: "adjustment_id in (select id from consolidation_adjustments where group_id = $1)",
  },
  {
    from: "consolidation_commentaries",
    to: "group_commentaries",
    columns: [
      "id",
      "group_id",
      "report",
      "period_label",
      "body",
      "status",
      "written_by_email",
      "written_via",
      "accepted_by_email",
      "accepted_at",
      "removed_by_email",
      "removed_at",
      "created_at",
      "updated_at",
    ],
    where: "group_id = $1",
  },
];

export const MOVE_STEPS = [
  "Make the steward tables (a new tenant migration) with the same columns and checks as the core tables.",
  "With the group read-only (no rate, adjustment or commentary changes), copy each core row into the steward's database in one transaction there.",
  "Check every table's row count and checksum agree between the core database and the steward's; stop if any differ.",
  "Switch the group to read its records from the steward (a flag on the group in the core registry), in one core transaction.",
  "Keep the core rows, unread, until a backup of the steward has been taken and restored; only a later, separate migration may remove them.",
  "Changing steward later repeats the same copy, check and switch between the two organisations' databases.",
];

export type MovePlanTable = { from: string; to: string; rows: number; checksum: string; roundTripChecksum: string; agrees: boolean };
export type MovePlan = { groupId: string; destructive: false; tables: MovePlanTable[]; steps: string[]; ready: boolean };

function canonical(rows: Array<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((row) => Object.keys(row).sort().map((key) => [key, row[key] === null ? null : String(row[key])]))))
    .digest("hex");
}

/** A row as it would be written to the steward table, and read back. */
export function toStewardRow(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(table.columns.map((column) => [column, row[column] ?? null]));
}

export function fromStewardRow(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(table.columns.map((column) => [column, row[column] ?? null]));
}

/** The dry run for one group: reads only. */
export async function planGroupRecordMove(groupIdInput: unknown): Promise<MovePlan> {
  const groupId = requireId(groupIdInput, "groupId");
  const tables: MovePlanTable[] = [];
  for (const table of MOVE_TABLES) {
    const found = await coreQuery<Record<string, unknown>>(
      `select ${table.columns.map((column) => `${column}::text as ${column}`).join(", ")} from ${table.from} where ${table.where} order by ${table.columns.slice(0, 3).map((column) => `${table.from}.${column}`).join(", ")}`,
      [groupId],
    );
    const source = found.rows.map((row) => toStewardRow(table, row));
    const back = source.map((row) => fromStewardRow(table, row));
    const checksum = canonical(found.rows);
    const roundTripChecksum = canonical(back);
    tables.push({ from: table.from, to: table.to, rows: found.rows.length, checksum, roundTripChecksum, agrees: checksum === roundTripChecksum });
  }
  return { groupId, destructive: false, tables, steps: MOVE_STEPS, ready: tables.every((table) => table.agrees) };
}
