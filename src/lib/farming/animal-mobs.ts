import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { requireId } from "@/lib/validation";

/*
 * Tagged animals and their mob's head (decisions 1482-1484; examples
 * AN3-AN6, common NZ practice, not yet reviewed). The mob's head is the one
 * count: tagging an animal into a mob never changes it, and a mob can't
 * have more tagged animals than head. A sale or death of tagged animals is
 * the mob's sale or death, naming which tags went; a split takes the tags
 * chosen; a merge takes them all. Used by the mob's own steps (mobs.ts).
 */

export async function taggedCount(tx: OrgTx, mobId: string): Promise<number> {
  const row = await tx.query<{ n: number }>("select count(*)::int as n from animal_mobs where mob_id = $1 and to_on is null", [mobId]);
  return row.rows[0]?.n ?? 0;
}

/** The tagged animals named for a mob's step: each is in this mob now, and there are no more than `max`. */
export async function requireTaggedIn(tx: OrgTx, mob: { id: string; name: string }, input: unknown, max: number): Promise<string[]> {
  if (input === undefined || input === null || input === "") return [];
  if (!Array.isArray(input) || input.length > 100000) throw new ValidationError("Choose the tagged animals as a list.");
  const ids = [...new Set(input.map((value) => requireId(value, "animalId")))];
  if (!ids.length) return [];
  if (ids.length > max) throw new ValidationError(`${ids.length} tagged animals were chosen, but the number is ${max}. Choose no more than ${max}.`);
  const found = await tx.query<{ animal_id: string; tag: string }>(
    "select am.animal_id::text, a.tag from animal_mobs am join animals a on a.id = am.animal_id where am.mob_id = $1 and am.to_on is null and am.animal_id = any($2::bigint[]) for update of am",
    [mob.id, ids],
  );
  if (found.rows.length !== ids.length) throw new ValidationError(`One of the animals chosen isn't in ${mob.name} now.`);
  return ids;
}

/** The mob's head after a step must still hold the tagged animals that stay (AN4). */
export async function checkTaggedFit(tx: OrgTx, mob: { id: string; name: string }, headAfter: number, leaving: number): Promise<void> {
  const staying = (await taggedCount(tx, mob.id)) - leaving;
  if (staying > headAfter) {
    const short = staying - headAfter;
    throw new ValidationError(
      headAfter === 0
        ? `${mob.name} has ${staying} tagged animal${staying === 1 ? "" : "s"} still in it. Choose which tagged animals went, so none is left in a mob with no head.`
        : `${mob.name} would have ${headAfter} head but ${staying} tagged animals in it. Choose at least ${short} more of the tagged animals that went.`,
    );
  }
}

/** Animals leave a mob (moved, split, merged, sold or died); sold and died change their status too. */
export async function animalsOut(tx: OrgTx, input: { animalIds: readonly string[]; mobId: string; onDate: string; how: "moved" | "split" | "merged" | "sold" | "died" | "corrected"; eventId: string | null }): Promise<void> {
  if (!input.animalIds.length) return;
  const open = await tx.query<{ from_on: string }>("select min(from_on)::text as from_on from animal_mobs where mob_id = $1 and to_on is null and animal_id = any($2::bigint[])", [input.mobId, input.animalIds]);
  if (open.rows[0]?.from_on && input.onDate < open.rows[0].from_on) throw new ValidationError(`One of the tagged animals went into the mob on ${open.rows[0].from_on}. The date can't be before that.`);
  await tx.query("update animal_mobs set to_on = $3, how_out = $4, out_event_id = $5 where mob_id = $1 and to_on is null and animal_id = any($2::bigint[])", [input.mobId, input.animalIds, input.onDate, input.how, input.eventId]);
  if (input.how === "sold" || input.how === "died") {
    await tx.query("update animals set status = $2, status_on = $3, status_event_id = $4 where id = any($1::bigint[])", [input.animalIds, input.how === "sold" ? "sold" : "dead", input.onDate, input.eventId]);
  }
}

export async function animalsIn(tx: OrgTx, input: { animalIds: readonly string[]; mobId: string; onDate: string; how: "tagged" | "moved" | "split" | "merged"; eventId: string | null }): Promise<void> {
  for (const animalId of input.animalIds) {
    await tx.query("insert into animal_mobs (animal_id, mob_id, from_on, how_in, in_event_id, created_by_email) values ($1, $2, $3, $4, $5, $6)", [animalId, input.mobId, input.onDate, input.how, input.eventId, tx.actor.email]);
  }
}

/** Every tagged animal in a mob now. */
export async function taggedIds(tx: OrgTx, mobId: string): Promise<string[]> {
  const rows = await tx.query<{ animal_id: string }>("select animal_id::text from animal_mobs where mob_id = $1 and to_on is null order by animal_id", [mobId]);
  return rows.rows.map((row) => row.animal_id);
}
