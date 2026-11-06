import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getAnimal } from "@/lib/farming/animal-detail";
import { updateAnimal } from "@/lib/farming/animals";

type Context = { params: Promise<{ animalId: string }> };

/** GET: an animal's page (decision 1485): details, mobs, weights, BCS, photos, suggestions, treatments, breeding and moves. */
export const GET = route<Context>(async (request, context) => {
  const { animalId } = await context.params;
  const detail = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getAnimal(tx, animalId));
  return json(detail);
});

/** PATCH: changes an animal's details (tag, EID, sex, breed, birth date, dam, sire, note). */
export const PATCH = route<Context>(async (request, context) => {
  const { animalId } = await context.params;
  const body = await readJson(request);
  const { organisationId: _organisationId, ...changes } = body;
  void _organisationId;
  const animal = await withFarmWork(request, body.organisationId, "record", (tx) => updateAnimal(tx, animalId, changes));
  return json({ animal });
});
