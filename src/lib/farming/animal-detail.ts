import type { OrgTx } from "@/lib/db/org-transaction";
import { type Animal, animalRow, animalWeights, type AnimalWeight, loadAnimals } from "@/lib/farming/animals";
import { tagKey, tagsInText } from "@/lib/farming/animal-rules";
import { animalBcs, type BcsPhoto, type BcsRecord, type BcsSuggestion, listSuggestions, photosFor, scaleFor } from "@/lib/farming/bcs";
import { type BcsTargets, targetsFor } from "@/lib/farming/bcs-rules";
import { mobName } from "@/lib/farming/mob-rules";
import { type BreedingRecord, listBreeding } from "@/lib/farming/planning";
import { listTreatments, type Treatment } from "@/lib/farming/treatments";

/*
 * An animal's page (decision 1485): its details, the mobs it was in, its
 * weights and BCS, photos and AI suggestions, treatments (given by its tag,
 * or to all of its mob while it was in it), the mob's mating, AI and
 * scanning while it was in it, and the mob's moves while it was in it.
 * Worked out when asked: nothing is copied.
 */

export type AnimalMobSpell = { mobId: string; mobName: string; fromOn: string; toOn: string | null; howIn: string; howOut: string | null };
export type AnimalTreatment = Treatment & { how: "tag" | "mob" };
export type AnimalMove = { date: string; mobName: string; from: string | null; to: string | null };

export type AnimalDetail = {
  animal: Animal;
  mobs: AnimalMobSpell[];
  weights: AnimalWeight[];
  bcs: BcsRecord[];
  scale: string;
  targets: BcsTargets | null;
  photos: BcsPhoto[];
  suggestions: BcsSuggestion[];
  treatments: AnimalTreatment[];
  breeding: BreedingRecord[];
  moves: AnimalMove[];
  offspring: Array<{ id: string; tag: string; birthOn: string | null; status: string }>;
};

const within = (date: string, spell: AnimalMobSpell) => date >= spell.fromOn && (spell.toOn === null || date < spell.toOn);

export async function getAnimal(tx: OrgTx, idInput: unknown): Promise<AnimalDetail> {
  const animal = await animalRow(tx, idInput);
  const spells = await tx.query<{ mob_id: string; name: string | null; kind: string; class_code: string; from_on: string; to_on: string | null; how_in: string; how_out: string | null }>(
    `select am.mob_id::text, m.name, m.kind, m.class_code, am.from_on::text, am.to_on::text, am.how_in, am.how_out
       from animal_mobs am join mobs m on m.id = am.mob_id where am.animal_id = $1 order by am.from_on desc, am.id desc`,
    [animal.id],
  );
  const mobs: AnimalMobSpell[] = spells.rows.map((row) => ({ mobId: row.mob_id, mobName: mobName({ name: row.name, kind: row.kind, classCode: row.class_code }), fromOn: row.from_on, toOn: row.to_on, howIn: row.how_in, howOut: row.how_out }));
  const keys = new Set([tagKey(animal.tag), ...(animal.eid ? [tagKey(animal.eid)] : [])]);
  const treatments: AnimalTreatment[] = [];
  for (const treatment of await listTreatments(tx, { farmId: animal.farmId })) {
    const byTag = tagsInText(treatment.animals).some((key) => keys.has(key));
    // A mob treated whole (no tags typed) counts for every animal in it that day.
    const byMob = !treatment.animals && treatment.mobId && mobs.some((spell) => spell.mobId === treatment.mobId && within(treatment.treatedOn, spell));
    if (byTag || byMob) treatments.push({ ...treatment, how: byTag ? "tag" : "mob" });
  }
  const breeding: BreedingRecord[] = [];
  const moves: AnimalMove[] = [];
  for (const mobId of new Set(mobs.map((spell) => spell.mobId))) {
    const own = mobs.filter((spell) => spell.mobId === mobId);
    for (const record of await listBreeding(tx, { mobId })) if (own.some((spell) => within(record.onDate, spell))) breeding.push(record);
    const events = await tx.query<{ event_date: string; from_name: string | null; to_name: string | null }>(
      `select e.event_date::text, fp.name as from_name, tp.name as to_name from mob_events e
         left join paddocks fp on fp.id = e.from_paddock_id left join paddocks tp on tp.id = e.to_paddock_id
        where e.mob_id = $1 and e.event_type = 'moved' order by e.event_date desc, e.id desc limit 500`,
      [mobId],
    );
    for (const event of events.rows) if (own.some((spell) => within(event.event_date, spell) || event.event_date === spell.fromOn)) moves.push({ date: event.event_date, mobName: own[0].mobName, from: event.from_name, to: event.to_name });
  }
  breeding.sort((a, b) => (a.onDate < b.onDate ? 1 : -1));
  moves.sort((a, b) => (a.date < b.date ? 1 : -1));
  const offspring = await loadAnimals(tx, "(a.dam_id = $1 or a.sire_id = $1)", [animal.id], 500);
  const scale = await scaleFor(tx, animal.farmId, animal.kind);
  return {
    animal,
    mobs,
    weights: await animalWeights(tx, animal.id),
    bcs: await animalBcs(tx, animal.id),
    scale,
    targets: targetsFor(animal.kind, scale),
    photos: await photosFor(tx, { animalId: animal.id }),
    suggestions: await listSuggestions(tx, { animalId: animal.id }),
    treatments,
    breeding,
    moves: moves.slice(0, 200),
    offspring: offspring.map((child) => ({ id: child.id, tag: child.tag, birthOn: child.birthOn, status: child.status })),
  };
}
