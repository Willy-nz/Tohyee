import type { TableCopy } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";

/*
 * Animals in the analytics file (decision 1495): `tohyee_farm_animals` (the
 * register, with the mob each is in now), `tohyee_farm_animal_weights` and
 * `tohyee_farm_bcs` (scores by animal or mob, as recorded; removed ones and
 * AI suggestions nobody accepted are left out). Gains and averages are
 * worked out in Analytics.
 */
export async function readAnimalTables(tx: OrgTx): Promise<TableCopy[]> {
  const animals = await tx.query<Record<string, string | null>>(
    `select a.id::text, f.name as farm, a.kind, a.tag, a.eid, a.sex, a.breed, a.birth_on::text, d.tag as dam, coalesce(s.tag, a.sire_text) as sire, a.status, a.status_on::text,
            am.mob_id::text, coalesce(m.name, m.class_code) as mob
       from animals a join farms f on f.id = a.farm_id
       left join animals d on d.id = a.dam_id left join animals s on s.id = a.sire_id
       left join animal_mobs am on am.animal_id = a.id and am.to_on is null left join mobs m on m.id = am.mob_id
      order by f.name, a.tag, a.id`,
  );
  const weights = await tx.query<Record<string, string | null>>(
    `select w.id::text, f.name as farm, w.animal_id::text, a.tag, a.kind, w.weighed_on::text, w.kg::text, w.source
       from animal_weights w join animals a on a.id = w.animal_id join farms f on f.id = w.farm_id
      where w.status = 'active' order by w.weighed_on, w.id`,
  );
  const scores = await tx.query<Record<string, string | null>>(
    `select r.id::text, f.name as farm, r.animal_id::text, a.tag, r.mob_id::text, coalesce(m.name, m.class_code) as mob, coalesce(a.kind, m.kind) as kind,
            r.scored_on::text, r.scale, r.score::text, r.head_scored::text, r.source
       from bcs_records r join farms f on f.id = r.farm_id left join animals a on a.id = r.animal_id left join mobs m on m.id = r.mob_id
      where r.status = 'active' order by r.scored_on, r.id`,
  );
  return [
    {
      name: "tohyee_farm_animals",
      columns: [
        { name: "animal_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "kind", type: "VARCHAR" },
        { name: "tag", type: "VARCHAR" },
        { name: "eid", type: "VARCHAR" },
        { name: "sex", type: "VARCHAR" },
        { name: "breed", type: "VARCHAR" },
        { name: "birth_on", type: "DATE" },
        { name: "dam_tag", type: "VARCHAR" },
        { name: "sire", type: "VARCHAR" },
        { name: "status", type: "VARCHAR" },
        { name: "status_on", type: "DATE" },
        { name: "mob_id", type: "BIGINT" },
        { name: "mob", type: "VARCHAR" },
      ],
      rows: animals.rows.map((row) => [row.id, row.farm, row.kind, row.tag, row.eid, row.sex, row.breed, row.birth_on, row.dam, row.sire, row.status, row.status_on, row.mob_id, row.mob]),
    },
    {
      name: "tohyee_farm_animal_weights",
      columns: [
        { name: "weight_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "animal_id", type: "BIGINT" },
        { name: "tag", type: "VARCHAR" },
        { name: "kind", type: "VARCHAR" },
        { name: "weighed_on", type: "DATE" },
        { name: "kg", type: "DECIMAL(7,1)" },
        { name: "source", type: "VARCHAR" },
      ],
      rows: weights.rows.map((row) => [row.id, row.farm, row.animal_id, row.tag, row.kind, row.weighed_on, row.kg, row.source]),
    },
    {
      name: "tohyee_farm_bcs",
      columns: [
        { name: "bcs_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "animal_id", type: "BIGINT" },
        { name: "tag", type: "VARCHAR" },
        { name: "mob_id", type: "BIGINT" },
        { name: "mob", type: "VARCHAR" },
        { name: "kind", type: "VARCHAR" },
        { name: "scored_on", type: "DATE" },
        { name: "scale", type: "VARCHAR" },
        { name: "score", type: "DECIMAL(3,1)" },
        { name: "head_scored", type: "INTEGER" },
        { name: "source", type: "VARCHAR" },
      ],
      rows: scores.rows.map((row) => [row.id, row.farm, row.animal_id, row.tag, row.mob_id, row.mob, row.kind, row.scored_on, row.scale === "1_10" ? "1 to 10" : "1 to 5", row.score, row.head_scored, row.source]),
    },
  ];
}
