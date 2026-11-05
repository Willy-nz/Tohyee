import type { TableCopy } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";

/*
 * Satellite vegetation in the analytics file (#612, decision 1538):
 * `tohyee_farm_paddock_greenness`, a row a paddock a satellite date as
 * worked out, with its clear pixels, clear share and quality. Greenness
 * (NDVI), not feed: there's no kg DM/ha column, and a date with no clear
 * view has no greenness (null), never 0. Like every tohyee_farm_ table, it's
 * only for members who see every farm (decision 744).
 */
export async function readVegetationTables(tx: OrgTx): Promise<TableCopy[]> {
  const exists = await tx.query<{ ok: boolean }>("select to_regclass('vegetation_observations') is not null as ok");
  if (!exists.rows[0]?.ok) return [];
  const rows = await tx.query<Record<string, string | null>>(
    `select o.id::text, f.name as farm, o.paddock_id::text, p.name as paddock, o.boundary_id::text,
            (o.boundary_id = (select max(pb.id) from paddock_boundaries pb where pb.paddock_id = o.paddock_id))::text as current_boundary,
            to_char(o.acquired_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as acquired_at_utc, to_char(o.acquired_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD') as acquired_on,
            o.mean_ndvi::text, o.median_ndvi::text, o.valid_pixels::text, o.total_pixels::text, o.coverage_pct::text, o.quality, array_to_string(o.flags, ' ') as flags,
            o.change_ndvi::text, s.provider, array_to_string(s.product_ids, ' ') as products, s.processing_baseline, o.processor_version
       from vegetation_observations o
       join vegetation_scenes s on s.id = o.scene_id
       join paddocks p on p.id = o.paddock_id
       join farms f on f.id = o.farm_id
      order by o.acquired_at, f.name, p.name, o.id`,
  );
  return [
    {
      name: "tohyee_farm_paddock_greenness",
      columns: [
        { name: "observation_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "paddock_id", type: "BIGINT" },
        { name: "paddock", type: "VARCHAR" },
        { name: "boundary_id", type: "BIGINT" },
        { name: "current_boundary", type: "BOOLEAN" },
        { name: "acquired_at_utc", type: "TIMESTAMP" },
        { name: "acquired_on", type: "DATE" },
        { name: "mean_ndvi", type: "DECIMAL(5,4)" },
        { name: "median_ndvi", type: "DECIMAL(5,4)" },
        { name: "valid_pixels", type: "INTEGER" },
        { name: "total_pixels", type: "INTEGER" },
        { name: "valid_coverage_pct", type: "DECIMAL(5,2)" },
        { name: "quality", type: "VARCHAR" },
        { name: "flags", type: "VARCHAR" },
        { name: "change_ndvi", type: "DECIMAL(5,4)" },
        { name: "source", type: "VARCHAR" },
        { name: "products", type: "VARCHAR" },
        { name: "processing_baseline", type: "VARCHAR" },
        { name: "processor_version", type: "VARCHAR" },
      ],
      rows: rows.rows.map((row) => [
        row.id,
        row.farm,
        row.paddock_id,
        row.paddock,
        row.boundary_id,
        row.current_boundary,
        row.acquired_at_utc,
        row.acquired_on,
        row.mean_ndvi,
        row.median_ndvi,
        row.valid_pixels,
        row.total_pixels,
        row.coverage_pct,
        row.quality,
        row.flags,
        row.change_ndvi,
        row.provider === "demo" ? "Made-up demo pictures" : "Contains modified Copernicus Sentinel data",
        row.products,
        row.processing_baseline,
        row.processor_version,
      ]),
    },
  ];
}
