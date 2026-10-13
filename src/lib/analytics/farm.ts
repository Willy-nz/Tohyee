import type { TableCopy } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";
import { dec, toFixedString } from "@/lib/money/decimal";

/*
 * Farm data in the organisation's analytics file (#249 stage 1, decision
 * 514), as `tohyee_farm_*` tables copied with the books while Farming is on.
 * Row for row, as recorded: nothing is worked out here. Paddock costs and
 * nutrients for a plan stay with the fertiliser planner (FB4-FB6); these
 * tables carry the ids to join applications to products and to the bill
 * lines in `tohyee_bill_lines` (bill_id and line).
 */

const HECTARES = "DECIMAL(18,2)";
const PERCENT = "DECIMAL(5,2)";
const TONNES = "DECIMAL(18,3)";
const RATE = "DECIMAL(18,2)";
const MONEY = "DECIMAL(18,2)";

export async function readFarmTables(tx: OrgTx): Promise<TableCopy[]> {
  const enabled = await tx.query<{ enabled: boolean }>(
    "select enabled from farming_settings where id = true",
  );
  if (enabled.rows[0]?.enabled !== true) return [];
  const tables: TableCopy[] = [];

  const paddocks = await tx.query<Record<string, string | null>>(
    `select p.id::text, f.name as farm, p.name, p.status, p.effective_ha::text, b.mapped_ha::text, p.created_on::text, p.retired_on::text,
            (select string_agg(o.name || ' (' || l.kind || ')', ', ' order by o.name) from paddock_lineage l join paddocks o on o.id = l.from_paddock_id where l.paddock_id = p.id) as came_from,
            b.geometry::text as geometry
       from paddocks p
       join farms f on f.id = p.farm_id
       left join lateral (select mapped_ha, geometry from paddock_boundaries pb where pb.paddock_id = p.id order by pb.id desc limit 1) b on true
      order by f.name, p.created_on, p.id`,
  );
  tables.push({
    name: "tohyee_farm_paddocks",
    columns: [
      { name: "paddock_id", type: "BIGINT" },
      { name: "farm", type: "VARCHAR" },
      { name: "paddock", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "effective_ha", type: HECTARES },
      { name: "mapped_ha", type: HECTARES },
      { name: "created_on", type: "DATE" },
      { name: "retired_on", type: "DATE" },
      { name: "came_from", type: "VARCHAR" },
      { name: "boundary_geojson", type: "VARCHAR" },
    ],
    rows: paddocks.rows.map((row) => [
      row.id,
      row.farm,
      row.name,
      row.status,
      row.effective_ha,
      // Mapped areas are stored unrounded; two places, like the paddock list.
      row.mapped_ha === null ? null : toFixedString(dec(row.mapped_ha), 2),
      row.created_on,
      row.retired_on,
      row.came_from,
      row.geometry,
    ]),
  });

  const products = await tx.query<Record<string, string | null>>(
    "select id::text, name, n_pct::text, p_pct::text, k_pct::text, s_pct::text, is_active::text from fertiliser_products order by lower(name), fertiliser_products.id",
  );
  tables.push({
    name: "tohyee_farm_fertiliser_products",
    columns: [
      { name: "product_id", type: "BIGINT" },
      { name: "product", type: "VARCHAR" },
      { name: "n_pct", type: PERCENT },
      { name: "p_pct", type: PERCENT },
      { name: "k_pct", type: PERCENT },
      { name: "s_pct", type: PERCENT },
      { name: "active", type: "BOOLEAN" },
    ],
    rows: products.rows.map((row) => [
      row.id,
      row.name,
      row.n_pct,
      row.p_pct,
      row.k_pct,
      row.s_pct,
      row.is_active,
    ]),
  });

  const planLines = await tx.query<Record<string, string | null>>(
    `select p.id::text as plan_id, p.name as plan, f.name as farm, v.version::text, (v.version = (select max(x.version) from fertiliser_plan_versions x where x.plan_id = p.id))::text as latest,
            v.created_at::date::text as saved_on, l.paddock_id::text, pd.name as paddock, l.product_id::text, pr.name as product,
            l.rate_kg_ha::text, l.treated_ha::text, l.price_per_tonne::text, v.spreading_per_ha::text
       from fertiliser_plan_lines l
       join fertiliser_plan_versions v on v.id = l.version_id
       join fertiliser_plans p on p.id = v.plan_id
       join farms f on f.id = p.farm_id
       join paddocks pd on pd.id = l.paddock_id
       join fertiliser_products pr on pr.id = l.product_id
      order by p.id, v.version, l.id`,
  );
  tables.push({
    name: "tohyee_farm_fertiliser_plan_lines",
    columns: [
      { name: "plan_id", type: "BIGINT" },
      { name: "plan", type: "VARCHAR" },
      { name: "farm", type: "VARCHAR" },
      { name: "version", type: "INTEGER" },
      { name: "latest", type: "BOOLEAN" },
      { name: "saved_on", type: "DATE" },
      { name: "paddock_id", type: "BIGINT" },
      { name: "paddock", type: "VARCHAR" },
      { name: "product_id", type: "BIGINT" },
      { name: "product", type: "VARCHAR" },
      { name: "rate_kg_ha", type: RATE },
      { name: "treated_ha", type: HECTARES },
      { name: "price_per_tonne", type: MONEY },
      { name: "spreading_per_ha", type: MONEY },
    ],
    rows: planLines.rows.map((row) => [
      row.plan_id,
      row.plan,
      row.farm,
      row.version,
      row.latest,
      row.saved_on,
      row.paddock_id,
      row.paddock,
      row.product_id,
      row.product,
      row.rate_kg_ha,
      row.treated_ha,
      row.price_per_tonne,
      row.spreading_per_ha,
    ]),
  });

  const applications = await tx.query<Record<string, string | null>>(
    `select a.id::text, p.id::text as plan_id, p.name as plan, f.name as farm, a.paddock_id::text, pd.name as paddock, a.product_id::text, pr.name as product,
            a.applied_on::text, a.tonnes::text, a.treated_ha::text, a.source
       from fertiliser_applications a
       join fertiliser_plans p on p.id = a.plan_id
       join farms f on f.id = p.farm_id
       join paddocks pd on pd.id = a.paddock_id
       join fertiliser_products pr on pr.id = a.product_id
      where a.status = 'active'
      order by a.applied_on, a.id`,
  );
  tables.push({
    name: "tohyee_farm_fertiliser_applications",
    columns: [
      { name: "application_id", type: "BIGINT" },
      { name: "plan_id", type: "BIGINT" },
      { name: "plan", type: "VARCHAR" },
      { name: "farm", type: "VARCHAR" },
      { name: "paddock_id", type: "BIGINT" },
      { name: "paddock", type: "VARCHAR" },
      { name: "product_id", type: "BIGINT" },
      { name: "product", type: "VARCHAR" },
      { name: "applied_on", type: "DATE" },
      { name: "tonnes", type: TONNES },
      { name: "treated_ha", type: HECTARES },
      { name: "source", type: "VARCHAR" },
    ],
    rows: applications.rows.map((row) => [
      row.id,
      row.plan_id,
      row.plan,
      row.farm,
      row.paddock_id,
      row.paddock,
      row.product_id,
      row.product,
      row.applied_on,
      row.tonnes,
      row.treated_ha,
      row.source,
    ]),
  });

  // Which bill lines bought product for a plan, and which spread which applications. Lines of approved and voided bills, as tohyee_bill_lines has them.
  const links = await tx.query<Record<string, string | null>>(
    `select 'product' as kind, pu.plan_id::text, b.id::text as bill_id, l.line_order::text as line, pu.product_id::text, pu.tonnes::text, null::text as application_id
       from fertiliser_purchases pu join bill_lines l on l.id = pu.bill_line_id join bills b on b.id = l.bill_id
      where b.status in ('approved', 'voided')
     union all
     select 'spreading', a.plan_id::text, b.id::text, l.line_order::text, null, null, s.application_id::text
       from fertiliser_spreading s join fertiliser_applications a on a.id = s.application_id and a.status = 'active'
       join bill_lines l on l.id = s.bill_line_id join bills b on b.id = l.bill_id
      where b.status in ('approved', 'voided')
     order by 2, 1, 3, 4, 7`,
  );
  tables.push({
    name: "tohyee_farm_fertiliser_bill_links",
    columns: [
      { name: "kind", type: "VARCHAR" },
      { name: "plan_id", type: "BIGINT" },
      { name: "bill_id", type: "BIGINT" },
      { name: "line", type: "INTEGER" },
      { name: "product_id", type: "BIGINT" },
      { name: "tonnes", type: TONNES },
      { name: "application_id", type: "BIGINT" },
    ],
    rows: links.rows.map((row) => [
      row.kind,
      row.plan_id,
      row.bill_id,
      row.line,
      row.product_id,
      row.tonnes,
      row.application_id,
    ]),
  });

  // Soil test results, one row per result, as the lab reported them (value is null for results like "<0.5").
  const soil = await tx.query<Record<string, string | null>>(
    `select t.id::text, f.name as farm, t.paddock_id::text, p.name as paddock, t.sampled_on::text, t.sample_name, t.lab, t.lab_reference, t.depth,
            r.measure, r.value::text, r.value_text, r.unit
       from soil_tests t join soil_test_results r on r.soil_test_id = t.id join paddocks p on p.id = t.paddock_id join farms f on f.id = t.farm_id
      where t.status = 'active'
      order by t.sampled_on, t.id, r.line_order`,
  );
  tables.push({
    name: "tohyee_farm_soil_results",
    columns: [
      { name: "soil_test_id", type: "BIGINT" },
      { name: "farm", type: "VARCHAR" },
      { name: "paddock_id", type: "BIGINT" },
      { name: "paddock", type: "VARCHAR" },
      { name: "sampled_on", type: "DATE" },
      { name: "sample_name", type: "VARCHAR" },
      { name: "lab", type: "VARCHAR" },
      { name: "lab_reference", type: "VARCHAR" },
      { name: "depth", type: "VARCHAR" },
      { name: "measure", type: "VARCHAR" },
      { name: "value", type: "DECIMAL(18,4)" },
      { name: "value_as_reported", type: "VARCHAR" },
      { name: "unit", type: "VARCHAR" },
    ],
    rows: soil.rows.map((row) => [
      row.id,
      row.farm,
      row.paddock_id,
      row.paddock,
      row.sampled_on,
      row.sample_name,
      row.lab,
      row.lab_reference,
      row.depth,
      row.measure,
      row.value,
      row.value_text,
      row.unit,
    ]),
  });

  return tables;
}
