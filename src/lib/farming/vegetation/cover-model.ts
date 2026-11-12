/**
 * Modelled pasture cover (#612 phase 3, MCV1-MCV8, decision 1596). The farm's
 * own measured readings (plate meter or another measurement, never an eye
 * estimate or an estimate of any kind) are paired with clear satellite views
 * of the same paddock, the line is checked on dates and farms it wasn't
 * fitted on, and an admin who has seen how far off it's been chooses the
 * error they'll accept and turns estimates on. Estimates are their own field
 * ("modelled cover"), worked out when read: they're never saved as readings,
 * never change a measurement, and nothing plans grazing or fertiliser from
 * them. One organisation's readings are never used for another's line.
 */
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type CoverPair, PAIR_DAYS, validate, type Validation } from "@/lib/farming/vegetation/cover-fit";
import { activeCoverModel, type CoverModel, type ModelRow, toModel } from "@/lib/farming/vegetation/cover-estimates";
import { weatherMaps } from "@/lib/farming/weather-history";
import { rainBefore, RAIN_WINDOW_DAYS, shiftDay, temperatureBefore } from "@/lib/farming/weather-history-rules";
import { requireVegetationFarm as requireFarm } from "@/lib/farming/vegetation/service";

/** Methods that measure cover (MCV2). Eye estimates, satellite, model and photo estimates aren't used. */
export const MEASURED_METHODS = ["plate_meter", "measured_other"] as const;

/**
 * MCV2: each measured reading with the clear view of the same paddock
 * closest in time, at most PAIR_DAYS apart, unless stock grazed it between
 * the two (the cover changed). `farmId` null: every farm.
 */
export async function coverPairs(tx: OrgTx, farmId: string | null): Promise<CoverPair[]> {
  const rows = await tx.query<{ farm_id: string; paddock_id: string; scene_id: string; image_on: string; measured_on: string; ndvi: string; cover: number }>(
    `select distinct on (r.id) r.farm_id::text, r.paddock_id::text, o.scene_id::text,
            (o.acquired_at at time zone 'Pacific/Auckland')::date::text as image_on, r.measured_on::text, o.mean_ndvi::text as ndvi, r.cover
       from pasture_readings r
       join vegetation_observations o on o.paddock_id = r.paddock_id and o.quality = 'good' and o.mean_ndvi is not null
        and abs((o.acquired_at at time zone 'Pacific/Auckland')::date - r.measured_on) <= $2
      where r.status = 'active' and r.method = any($3::text[]) and ($1::bigint is null or r.farm_id = $1)
        and not exists (
          select 1 from grazings g
           where g.paddock_id = r.paddock_id and g.status = 'active'
             and g.in_on <= greatest(r.measured_on, (o.acquired_at at time zone 'Pacific/Auckland')::date)
             and coalesce(g.out_on, g.in_on) >= least(r.measured_on, (o.acquired_at at time zone 'Pacific/Auckland')::date)
             and r.measured_on <> (o.acquired_at at time zone 'Pacific/Auckland')::date)
      order by r.id, abs((o.acquired_at at time zone 'Pacific/Auckland')::date - r.measured_on), o.acquired_at desc`,
    [farmId, PAIR_DAYS, [...MEASURED_METHODS]],
  );
  // MCV9: the weather in the 14 days before each picture, where it's known.
  const maps = new Map<string, Awaited<ReturnType<typeof weatherMaps>>>();
  for (const farm of new Set(rows.rows.map((row) => row.farm_id))) {
    const dates = rows.rows.filter((row) => row.farm_id === farm).map((row) => row.image_on).sort();
    maps.set(farm, await weatherMaps(tx, farm, shiftDay(dates[0], -RAIN_WINDOW_DAYS), dates[dates.length - 1]));
  }
  return rows.rows.map((row) => {
    const weather = maps.get(row.farm_id)!;
    return {
      farmId: row.farm_id,
      paddockId: row.paddock_id,
      sceneId: row.scene_id,
      imageOn: row.image_on,
      measuredOn: row.measured_on,
      ndvi: row.ndvi,
      cover: row.cover,
      rain14: rainBefore(weather.rain, row.image_on),
      temperature14: temperatureBefore(weather.temperature, row.image_on),
    };
  });
}

export type CoverCheck = { farmId: string; farmName: string; validation: Validation; model: CoverModel | null; pairDays: number };

/** MCV3-MCV5: the farm's line now, how it did on dates and farms it wasn't fitted on, and the line in use. Read-only. */
export async function coverCheck(tx: OrgTx, farmIdInput: unknown): Promise<CoverCheck> {
  const farm = await requireFarm(tx, farmIdInput);
  const all = await coverPairs(tx, null);
  const validation = validate(
    all.filter((pair) => pair.farmId === farm.id),
    all.filter((pair) => pair.farmId !== farm.id),
  );
  return { farmId: farm.id, farmName: farm.name, validation, model: await activeCoverModel(tx, farm.id), pairDays: PAIR_DAYS };
}

/**
 * MCV7: an admin turns estimates on, having chosen the error they'll accept
 * (kg DM/ha, on average). Refused unless the line has been checked and did
 * at least that well on dates it wasn't fitted on. The line is kept as it
 * was checked; later readings don't change it until it's turned on again.
 */
export async function turnOnCoverEstimates(tx: OrgTx, farmIdInput: unknown, input: { acceptableError: unknown }): Promise<CoverModel> {
  const acceptable = input.acceptableError;
  if (typeof acceptable !== "number" || !Number.isInteger(acceptable) || acceptable < 10 || acceptable > 3000) {
    throw new ValidationError("Choose the average error you'll accept, in kg DM/ha: a whole number from 10 to 3000.");
  }
  const check = await coverCheck(tx, farmIdInput);
  const { validation } = check;
  if (!validation.line || !validation.withheldDates || !validation.ndviRange) throw new ConflictError(validation.notReady ?? "There's no checked line for this farm yet.");
  // MCV9: the weather's line only when it did better on dates it wasn't fitted on.
  const weatherOption = validation.weather?.best && validation.weather.best !== "greenness" ? validation.weather.options.find((option) => option.terms === validation.weather!.best)! : null;
  const line = weatherOption?.line ?? validation.line;
  const errors = weatherOption?.withheldDates ?? validation.withheldDates;
  if (errors.meanError > acceptable) {
    throw new ConflictError(`On dates it wasn't fitted on, the line was off by ${errors.meanError} kg DM/ha on average, more than the ${acceptable} you chose. Estimates stay off.`);
  }
  await tx.query("update vegetation_cover_models set turned_off_at = now(), turned_off_by_email = $2 where farm_id = $1 and turned_off_at is null", [check.farmId, tx.actor.email]);
  const saved = await tx.query<ModelRow>(
    `insert into vegetation_cover_models (farm_id, intercept, slope, ndvi_min, ndvi_max, likely_within, mean_error, bias, acceptable_error, pairs, dates, validation, turned_on_by_email,
                                          rain_coefficient, temperature_coefficient)
     values ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::numeric, $15::numeric)
     returning id::text, intercept::text, slope::text, rain_coefficient::text, temperature_coefficient::text, ndvi_min::text, ndvi_max::text, likely_within, mean_error, acceptable_error, pairs, dates,
               turned_on_by_email, to_char(turned_on_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as turned_on_at`,
    [
      check.farmId,
      line.intercept,
      line.slope,
      validation.ndviRange.min,
      validation.ndviRange.max,
      errors.likelyWithin,
      errors.meanError,
      errors.bias,
      acceptable,
      weatherOption ? validation.weather!.pairs : validation.pairs,
      weatherOption ? validation.weather!.dates : validation.dates,
      JSON.stringify(validation),
      tx.actor.email,
      line.rain ?? null,
      line.temperature ?? null,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "vegetation.cover_estimates_on",
    entityType: "farm",
    entityId: check.farmId,
    details: { acceptableError: acceptable, meanError: errors.meanError, pairs: validation.pairs, dates: validation.dates, line, terms: validation.weather?.best ?? "greenness" },
  });
  return toModel(saved.rows[0]);
}

/** Turns the farm's estimates off. Nothing else changes. */
export async function turnOffCoverEstimates(tx: OrgTx, farmIdInput: unknown): Promise<void> {
  const farm = await requireFarm(tx, farmIdInput);
  const off = await tx.query("update vegetation_cover_models set turned_off_at = now(), turned_off_by_email = $2 where farm_id = $1 and turned_off_at is null", [farm.id, tx.actor.email]);
  if ((off.rowCount ?? 0) > 0) await writeAuditEvent(tx, { eventType: "vegetation.cover_estimates_off", entityType: "farm", entityId: farm.id, details: {} });
}
