import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { toFixedString } from "@/lib/money/decimal";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { optionalId, requireId } from "@/lib/validation";
import { financialYearEndMonth, naturalAmount } from "@/lib/reports/financial";
import { farmBenchmarks, FWE_GROUPS, parseFigures, yearEndOf } from "./benchmarks";
import { type FarmSplit, type Figures, farmForValues, splitByFarm } from "./farm-reporting-rules";
import { requireFarming } from "./paddocks";

/*
 * Farm-level reporting (#390; FR1-FR8, decision 743, not yet reviewed). The
 * farm is carried by a tracking category, as Xero tracking categories carry
 * a farm or block: Farming settings name the category and each farm is
 * linked to one of its values. See farm-reporting-rules.ts for the sums.
 */

export type FarmReportingSetup = {
  advancedFeatures: boolean;
  /** The category that says which farm a line is for; null when none is chosen. */
  category: { id: string; name: string } | null;
  /** Categories that could be chosen (active ones). */
  categories: Array<{ id: string; name: string }>;
  /** The chosen category's values, in tree order. */
  values: Array<{ id: string; parentId: string | null; path: string; isActive: boolean }>;
  farms: Array<{ id: string; name: string; isActive: boolean; trackingValueId: string | null; valuePath: string | null }>;
};

async function categoryValues(tx: OrgTx, categoryId: string) {
  const rows = await tx.query<{ id: string; parent_id: string | null; name: string; is_active: boolean }>(
    "select id::text, parent_id::text, name, is_active from tracking_values where category_id = $1 order by lower(name), tracking_values.id",
    [categoryId],
  );
  const children = new Map<string, typeof rows.rows>();
  for (const row of rows.rows) children.set(row.parent_id ?? "", [...(children.get(row.parent_id ?? "") ?? []), row]);
  const tree = (parent: string | null, prefix: string): FarmReportingSetup["values"] =>
    (children.get(parent ?? "") ?? []).flatMap((row) => {
      const path = prefix ? `${prefix} › ${row.name}` : row.name;
      return [{ id: row.id, parentId: row.parent_id, path, isActive: row.is_active }, ...tree(row.id, path)];
    });
  return tree(null, "");
}

export async function getFarmReportingSetup(tx: OrgTx): Promise<FarmReportingSetup> {
  await requireFarming(tx);
  const setting = await tx.query<{ id: string | null; name: string | null }>(
    "select c.id::text, c.name from farming_settings s left join tracking_categories c on c.id = s.farm_tracking_category_id where s.id = true",
  );
  const category = setting.rows[0]?.id ? { id: setting.rows[0].id, name: setting.rows[0].name! } : null;
  const categories = await tx.query<{ id: string; name: string }>("select id::text, name from tracking_categories where is_active order by sort_order, tracking_categories.id");
  const values = category ? await categoryValues(tx, category.id) : [];
  const paths = new Map(values.map((value) => [value.id, value.path]));
  const farms = await tx.query<{ id: string; name: string; is_active: boolean; tracking_value_id: string | null }>(
    "select id::text, name, is_active, tracking_value_id::text from farms order by not is_active, lower(name), farms.id",
  );
  return {
    advancedFeatures: await advancedFeaturesOn(tx),
    category,
    categories: categories.rows,
    values,
    farms: farms.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      trackingValueId: row.tracking_value_id,
      valuePath: row.tracking_value_id ? (paths.get(row.tracking_value_id) ?? null) : null,
    })),
  };
}

/**
 * Chooses the tracking category that carries the farm (FR1), or none. Links
 * to another category's values are cleared, since they'd no longer say
 * anything; the history records which.
 */
export async function setFarmTrackingCategory(tx: OrgTx, input: { categoryId: unknown }): Promise<FarmReportingSetup> {
  await requireFarming(tx);
  const categoryId = optionalId(input.categoryId, "categoryId");
  if (categoryId) {
    if (!(await advancedFeaturesOn(tx))) throw new ValidationError("Turn on tracking categories (Settings › Advanced features) first.");
    const found = await tx.query<{ is_active: boolean }>("select is_active from tracking_categories where id = $1", [categoryId]);
    if (!found.rows[0]) throw new NotFoundError("There's no such tracking category.");
    if (!found.rows[0].is_active) throw new ValidationError("That tracking category is archived.");
  }
  const cleared = await tx.query<{ id: string }>(
    `update farms set tracking_value_id = null
      where tracking_value_id is not null
        and ($1::bigint is null or tracking_value_id not in (select id from tracking_values where category_id = $1))
      returning id::text`,
    [categoryId],
  );
  await tx.query("update farming_settings set farm_tracking_category_id = $1, updated_by_email = $2, updated_at = now() where id = true", [categoryId, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.farm_tracking_category_set", entityType: "organisation", entityId: tx.organisationId, details: { categoryId, unlinkedFarms: cleared.rows.map((row) => row.id) } });
  return getFarmReportingSetup(tx);
}

/**
 * Links a farm to a value of the chosen category, or unlinks it (FR1). A value
 * can be one farm's only, and can't sit above or below another farm's value:
 * a line would then count for two farms.
 */
export async function linkFarmTrackingValue(tx: OrgTx, input: { farmId: unknown; valueId: unknown }): Promise<FarmReportingSetup> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  const valueId = optionalId(input.valueId, "valueId");
  const farm = await tx.query<{ name: string }>("select name from farms where id = $1", [farmId]);
  if (!farm.rows[0]) throw new NotFoundError("Farm not found.");
  if (valueId) {
    const setup = await getFarmReportingSetup(tx);
    if (!setup.category) throw new ValidationError("Choose the tracking category that says which farm a line is for first.");
    const value = setup.values.find((entry) => entry.id === valueId);
    if (!value) throw new ValidationError(`That value isn't in ${setup.category.name}.`);
    if (!value.isActive) throw new ValidationError(`${value.path} is archived.`);
    const links = new Map(setup.farms.filter((entry) => entry.trackingValueId && entry.id !== farmId).map((entry) => [entry.trackingValueId!, entry.id]));
    const below = farmForValues(setup.values, links);
    const owner = below.get(valueId);
    if (owner) throw new ConflictError(`${value.path} already counts for ${setup.farms.find((entry) => entry.id === owner)!.name}.`);
    const under = farmForValues(setup.values, new Map([[valueId, farmId]]));
    const clash = setup.farms.find((entry) => entry.id !== farmId && entry.trackingValueId && under.get(entry.trackingValueId) === farmId);
    if (clash) throw new ConflictError(`${clash.valuePath} (${clash.name}) is under ${value.path}: a line would count for both farms.`);
  }
  await tx.query("update farms set tracking_value_id = $2 where id = $1", [farmId, valueId]);
  await writeAuditEvent(tx, { eventType: "farming.farm_tracking_value_set", entityType: "farm", entityId: farmId, details: { valueId } });
  return getFarmReportingSetup(tx);
}

export type FarmYearFigures = Figures & { farmId: string; yearEnd: string };

/** Each farm's own physical figures for a year (FR4); blank where not entered. */
export async function listFarmYearFigures(tx: OrgTx, yearEndInput: unknown): Promise<FarmYearFigures[]> {
  await requireFarming(tx);
  const yearEnd = yearEndOf(yearEndInput, await financialYearEndMonth(tx));
  const rows = await tx.query<{ farm_id: string; effective_ha: string | null; peak_cows: number | null; stock_units: string | null; milk_solids_kg: string | null }>(
    "select farm_id::text, effective_ha::text, peak_cows, stock_units::text, milk_solids_kg::text from farm_year_figures_by_farm where year_end = $1",
    [yearEnd],
  );
  return rows.rows.map((row) => ({ farmId: row.farm_id, yearEnd, effectiveHa: row.effective_ha, peakCows: row.peak_cows, stockUnits: row.stock_units, milkSolidsKg: row.milk_solids_kg }));
}

/** Saves one farm's figures for a year (FR4); all blank removes them. */
export async function setFarmYearFigures(
  tx: OrgTx,
  input: { farmId: unknown; yearEnd: unknown; effectiveHa?: unknown; peakCows?: unknown; stockUnits?: unknown; milkSolidsKg?: unknown },
): Promise<FarmYearFigures[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  const yearEnd = yearEndOf(input.yearEnd, await financialYearEndMonth(tx));
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  const figures = parseFigures(input);
  if (figures.effectiveHa === null && figures.peakCows === null && figures.stockUnits === null && figures.milkSolidsKg === null) {
    await tx.query("delete from farm_year_figures_by_farm where farm_id = $1 and year_end = $2", [farmId, yearEnd]);
  } else {
    await tx.query(
      `insert into farm_year_figures_by_farm (farm_id, year_end, effective_ha, peak_cows, stock_units, milk_solids_kg, updated_by_email)
       values ($1, $2, $3::numeric, $4, $5::numeric, $6::numeric, $7)
       on conflict (farm_id, year_end) do update set effective_ha = excluded.effective_ha, peak_cows = excluded.peak_cows, stock_units = excluded.stock_units,
         milk_solids_kg = excluded.milk_solids_kg, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [farmId, yearEnd, figures.effectiveHa, figures.peakCows, figures.stockUnits, figures.milkSolidsKg, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "farming.farm_year_figures_saved", entityType: "farm", entityId: farmId, details: { yearEnd, ...figures } });
  return listFarmYearFigures(tx, yearEnd);
}

export type FarmBenchmarksByFarm = FarmSplit & {
  yearStart: string;
  yearEnd: string;
  category: { id: string; name: string } | null;
  /** Active farms with no value linked: their lines can only be Not allocated. */
  unlinkedFarms: string[];
};

/**
 * The year's benchmarks split by farm (FR2-FR7): one column per farm linked
 * to a value (archived ones only if they have amounts), Not allocated, and
 * the total, which is exactly farmBenchmarks (FK3).
 */
export async function farmBenchmarksByFarm(tx: OrgTx, input: { yearEnd: unknown }): Promise<FarmBenchmarksByFarm> {
  const whole = await farmBenchmarks(tx, input);
  const setup = await getFarmReportingSetup(tx);
  const unlinkedFarms = setup.farms.filter((farm) => farm.isActive && !farm.trackingValueId).map((farm) => farm.name);
  const linked = setup.category ? setup.farms.filter((farm) => farm.trackingValueId) : [];
  const valueFarm = farmForValues(setup.values, new Map(linked.map((farm) => [farm.trackingValueId!, farm.id])));
  const rows = await tx.query<{ id: string; account_class: string; account_type: string; debits: string; credits: string; value_id: string | null }>(
    `select a.id::text, a.account_class, a.account_type, (l.tracking ->> $3::text) as value_id,
            coalesce(sum(l.debit_amount), 0)::text as debits, coalesce(sum(l.credit_amount), 0)::text as credits
       from accounts a
       join ledger_journal_lines l on l.account_id = a.id
       join ledger_journals j on j.id = l.journal_id
      where j.posting_date between $1 and $2 and a.account_class in ('revenue', 'expense')
      group by a.id, value_id
      order by a.id`,
    [whole.yearStart, whole.yearEnd, setup.category?.id ?? "0"],
  );
  const lines = rows.rows.map((row) => ({
    accountId: row.id,
    accountClass: row.account_class,
    accountType: row.account_type,
    farmId: row.value_id ? (valueFarm.get(row.value_id) ?? null) : null,
    amount: toFixedString(naturalAmount(row as unknown as Parameters<typeof naturalAmount>[0]), 2),
  }));
  const used = new Set(lines.filter((line) => line.farmId !== null).map((line) => line.farmId));
  const figures = new Map((await listFarmYearFigures(tx, whole.yearEnd)).map((row) => [row.farmId, row]));
  const grouping = new Map((await tx.query<{ account_id: string; group_key: string }>("select account_id::text, group_key from farm_expense_groups")).rows.map((row) => [row.account_id, row.group_key]));
  const split = splitByFarm({
    lines,
    grouping,
    groups: FWE_GROUPS,
    farms: linked.filter((farm) => farm.isActive || used.has(farm.id)).map((farm) => ({ id: farm.id, name: farm.name, figures: figures.get(farm.id) ?? null })),
    organisationFigures: whole.figures,
  });
  return { ...split, yearStart: whole.yearStart, yearEnd: whole.yearEnd, category: setup.category, unlinkedFarms };
}
