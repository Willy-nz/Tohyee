import type { TableCopy } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";

/*
 * Rainfall in the analytics file (decision 1455): `tohyee_farm_rainfall`,
 * a row a reading as recorded (removed ones left out), with its gauge and
 * farm. Totals by month or season are worked out in Analytics.
 */
export async function readRainfallTables(tx: OrgTx): Promise<TableCopy[]> {
  const rows = await tx.query<Record<string, string | null>>(
    `select r.id::text, f.name as farm, g.id::text as gauge_id, g.name as gauge, r.read_on::text, r.mm::text, r.note, r.source
       from rainfall_readings r join rain_gauges g on g.id = r.gauge_id join farms f on f.id = r.farm_id
      where r.status = 'active' order by r.read_on, r.id`,
  );
  return [
    {
      name: "tohyee_farm_rainfall",
      columns: [
        { name: "reading_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "gauge_id", type: "BIGINT" },
        { name: "gauge", type: "VARCHAR" },
        { name: "read_on", type: "DATE" },
        { name: "mm", type: "DECIMAL(6,1)" },
        { name: "note", type: "VARCHAR" },
        { name: "source", type: "VARCHAR" },
      ],
      rows: rows.rows.map((row) => [row.id, row.farm, row.gauge_id, row.gauge, row.read_on, row.mm, row.note, row.source]),
    },
  ];
}
