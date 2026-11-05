import type { OrgTx } from "@/lib/db/org-transaction";
import { laterDate, meatSafeOn, milkSafeFrom, type Withholding } from "@/lib/farming/treatment-rules";
import { addDays } from "@/lib/farming/farm-words";

/*
 * Withholding worked out from what was recorded (decisions 1432-1433;
 * TRT1-TRT4). Only queries: no checks of who's asking (callers have done
 * that for the farm).
 */

export type MobWithholding = Withholding & { treatmentIds: string[] };

/**
 * Each mob's withholding: its own treatments, and those of mobs its
 * animals came from by a split or merge after the treatment (TRT3), so
 * stock split off a treated mob, or merged into another, carries the
 * withholding with it.
 */
export async function mobWithholdings(tx: OrgTx, farmId: string): Promise<Map<string, MobWithholding>> {
  const treatments = await tx.query<{ id: string; mob_id: string; treated_on: string; given_time: string | null; meat: number | null; milk: number | null }>(
    `select t.id::text, t.mob_id::text, t.treated_on::text, to_char(t.given_time, 'HH24:MI') as given_time, t.meat_withholding_days as meat, t.milk_withholding_hours as milk
       from animal_treatments t where t.farm_id = $1 and t.status = 'active' and t.mob_id is not null
        and (t.meat_withholding_days is not null or t.milk_withholding_hours is not null)`,
    [farmId],
  );
  const result = new Map<string, MobWithholding>();
  if (!treatments.rows.length) return result;
  // Where each mob's animals came from: split from (the parent), merged in (the other mob), on a date.
  const joins = await tx.query<{ mob_id: string; from_mob_id: string; on_date: string }>(
    `select e.mob_id::text, e.other_mob_id::text as from_mob_id, e.event_date::text as on_date
       from mob_events e where e.farm_id = $1 and e.event_type in ('split_in', 'merged_in') and e.other_mob_id is not null`,
    [farmId],
  );
  const byMob = new Map<string, typeof treatments.rows>();
  for (const row of treatments.rows) byMob.set(row.mob_id, [...(byMob.get(row.mob_id) ?? []), row]);
  const add = (mobId: string, row: (typeof treatments.rows)[number]) => {
    const current = result.get(mobId) ?? { meatSafeOn: null, milkSafeFrom: null, treatmentIds: [] };
    if (current.treatmentIds.includes(row.id)) return;
    result.set(mobId, {
      meatSafeOn: laterDate(current.meatSafeOn, meatSafeOn(row.treated_on, row.meat)),
      milkSafeFrom: laterDate(current.milkSafeFrom, milkSafeFrom(row.treated_on, row.milk, row.given_time)),
      treatmentIds: [...current.treatmentIds, row.id],
    });
  };
  const mobs = new Set([...byMob.keys(), ...joins.rows.map((row) => row.mob_id)]);
  for (const mobId of mobs) {
    // Walk back through splits and merges (at most 20 steps), keeping treatments given before the animals joined.
    const queue: Array<{ mob: string; before: string }> = [{ mob: mobId, before: "9999-12-31" }];
    const seen = new Set<string>();
    for (let step = 0; queue.length && step < 200; step += 1) {
      const { mob, before } = queue.shift()!;
      const key = `${mob}|${before}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const row of byMob.get(mob) ?? []) if (row.treated_on <= before) add(mobId, row);
      for (const join of joins.rows) if (join.mob_id === mob && join.on_date <= before) queue.push({ mob: join.from_mob_id, before: join.on_date });
    }
  }
  return result;
}

export type PaddockWithheld = { paddockId: string; until: string; product: string | null; jobId: string };

/**
 * Paddocks not safe to graze on `onDate` (TRT5): an active spray job's
 * withholding, from the day spraying finished, for each of the job's
 * paddocks. "Until" is the first day it's safe. Withdrawn jobs don't count.
 */
export async function paddockWithholdings(tx: OrgTx, farmId: string, onDate: string): Promise<Map<string, PaddockWithheld>> {
  const rows = await tx.query<{ paddock_id: string; from_on: string; days: number; product: string | null; job_id: string }>(
    `select p.paddock_id::text, w.from_on::text, w.days, j.product, j.id::text as job_id
       from paddock_withholdings w
       join tractor_jobs j on j.id = w.tractor_job_id and j.status = 'active'
       cross join lateral unnest(j.paddock_ids) as p(paddock_id)
      where w.farm_id = $1 and w.status = 'active' and w.from_on + w.days > $2::date and w.from_on <= $2::date`,
    [farmId, onDate],
  );
  const result = new Map<string, PaddockWithheld>();
  for (const row of rows.rows) {
    const until = addDays(row.from_on, row.days);
    const current = result.get(row.paddock_id);
    if (!current || until > current.until) result.set(row.paddock_id, { paddockId: row.paddock_id, until, product: row.product, jobId: row.job_id });
  }
  return result;
}
