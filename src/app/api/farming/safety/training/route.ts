import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { safetyPeople, safetyPeopleMap } from "@/lib/safety/people";
import { canRecordSafety } from "@/lib/safety/records";
import { addTraining, listTraining } from "@/lib/safety/register";

/** GET: the training register (`mine=true`: only the person's own), soonest to expire first. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    training: await listTraining(tx, { mine: params.get("mine") === "true" }),
    canRecord: canRecordSafety(tx),
    people: canRecordSafety(tx) ? await safetyPeople(tx.organisationId) : [],
    userId: tx.actor.userId,
  }));
  return json(result);
});

/** Adds a training record (`person`: a member's `userId` or a `name`; `what`, `completedOn`, `expiresOn`, ...). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const training = await withOrganisation(request, body.organisationId, "viewer", async (tx) => addTraining(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json({ training }, { status: 201 });
});
