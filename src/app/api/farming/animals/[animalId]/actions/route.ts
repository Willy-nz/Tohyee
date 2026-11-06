import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { placeAnimal, setAnimalStatus } from "@/lib/farming/animals";
import { recordReadings } from "@/lib/farming/bcs";

type Context = { params: Promise<{ animalId: string }> };

/**
 * One step for an animal (`action`): "readings" (a score and/or a weight,
 * from quick entry, also from the phone's queue), "place" (put it in a mob
 * or correct its mob: no head changes), "missing" or "found".
 */
export const POST = route<Context>(async (request, context) => {
  const { animalId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", async (tx) => {
    switch (body.action) {
      case "readings":
        return recordReadings(tx, animalId, body);
      case "place":
        return { animal: await placeAnimal(tx, animalId, { mobId: body.mobId, onDate: body.onDate }), message: "Saved." };
      case "missing":
      case "found":
        return { animal: await setAnimalStatus(tx, animalId, { status: body.action === "missing" ? "missing" : "on_farm", onDate: body.onDate }), message: "Saved." };
      default:
        throw new ValidationError("action must be readings, place, missing or found.");
    }
  });
  return json(result, { status: 201 });
});
