import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError } from "@/lib/errors";
import { farmScope } from "@/lib/farming/access";

/*
 * Analytics' farm tables (tohyee_farm_*) are copies of every farm's records,
 * so a member who sees only some farms (decision 744) can't use them, or any
 * shaped table built from them. Their other tables are unchanged.
 */

const FARM_PREFIX = "tohyee_farm_";

/** The farm tables (and tables shaped from them) this person can't use; null when they see every farm. */
export async function hiddenFarmTables(tx: OrgTx): Promise<{ has: (table: string) => boolean } | null> {
  if ((await farmScope(tx)).all) return null;
  const shapes = await tx.query<{ table_name: string; base_table: string; steps: unknown }>("select table_name, base_table, steps from analytics_shaped_tables");
  const needs = new Map(
    shapes.rows.map((shape) => {
      const steps = Array.isArray(shape.steps) ? (shape.steps as Array<{ type?: string; table?: string }>) : [];
      return [shape.table_name, [shape.base_table, ...steps.filter((step) => (step.type === "merge" || step.type === "append") && typeof step.table === "string").map((step) => step.table!)]];
    }),
  );
  const hidden = new Map<string, boolean>();
  const isHidden = (table: string, seen = new Set<string>()): boolean => {
    if (table.startsWith(FARM_PREFIX)) return true;
    if (hidden.has(table)) return hidden.get(table)!;
    if (seen.has(table)) return false;
    seen.add(table);
    const result = (needs.get(table) ?? []).some((dependency) => isHidden(dependency, seen));
    hidden.set(table, result);
    return result;
  };
  return { has: (table) => isHidden(table) };
}

export async function requireAnalyticsTable(tx: OrgTx, table: unknown): Promise<void> {
  const hidden = await hiddenFarmTables(tx);
  if (hidden && typeof table === "string" && hidden.has(table)) {
    throw new ForbiddenError("Farm tables in Analytics hold every farm's records, so they're for members who see every farm. An owner or admin can change which farms you see.");
  }
}
