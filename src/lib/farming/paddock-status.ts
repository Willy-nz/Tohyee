import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError } from "@/lib/errors";
import { parseIsoDate } from "@/lib/dates";
import { requireFarmAccess } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { isEstimate, type PastureMethod } from "@/lib/farming/pasture-rules";
import { requireId } from "@/lib/validation";

/*
 * Each paddock's facts for the farm map and its paddock card (#447,
 * decision 907): the latest cover reading and its date, the mob in now,
 * and when it was last grazed, on a date. One query each, a row per
 * paddock, whatever the size of the history. Records only: nothing here is
 * judged.
 */

export type PaddockStatus = {
  paddockId: string;
  name: string;
  hectares: string | null;
  /** The mob in now (no day out, or a day out after the date). */
  inNow: { grazingId: string; mob: string; head: number | null; inOn: string } | null;
  /** The day the last mob came out, on or before the date (null when in now and never grazed before, or never grazed). */
  lastGrazedOn: string | null;
  cover: { cover: number; measuredOn: string; method: PastureMethod; estimate: boolean } | null;
};

export async function paddockStatuses(tx: OrgTx, input: { farmId: unknown; onDate: unknown }): Promise<PaddockStatus[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  const onDate = parseIsoDate(input.onDate, "On date");
  const rows = await tx.query<{
    id: string;
    name: string;
    hectares: string | null;
    grazing_id: string | null;
    mob: string | null;
    head: number | null;
    in_on: string | null;
    last_out: string | null;
    cover: number | null;
    measured_on: string | null;
    method: PastureMethod | null;
  }>(
    `select p.id::text, p.name,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares,
            g.id::text as grazing_id, g.mob, g.head, g.in_on::text,
            (select max(o.out_on) from grazings o where o.paddock_id = p.id and o.status = 'active' and o.out_on is not null and o.out_on <= $2)::text as last_out,
            r.cover, r.measured_on::text, r.method
       from paddocks p
       left join lateral (select g.id, g.mob, g.head, g.in_on from grazings g
                           where g.paddock_id = p.id and g.status = 'active' and g.in_on <= $2 and (g.out_on is null or g.out_on > $2)
                           order by g.in_on desc, g.id desc limit 1) g on true
       left join lateral (select r.cover, r.measured_on, r.method from pasture_readings r
                           where r.paddock_id = p.id and r.status = 'active' and r.measured_on <= $2
                           order by r.measured_on desc, r.id desc limit 1) r on true
      where p.farm_id = $1 and p.status = 'active'
      order by p.name, p.id`,
    [farmId, onDate],
  );
  return rows.rows.map((row) => ({
    paddockId: row.id,
    name: row.name,
    hectares: row.hectares,
    inNow: row.grazing_id ? { grazingId: row.grazing_id, mob: row.mob!, head: row.head, inOn: row.in_on! } : null,
    lastGrazedOn: row.last_out,
    cover: row.cover === null ? null : { cover: row.cover, measuredOn: row.measured_on!, method: row.method!, estimate: isEstimate(row.method!) },
  }));
}
