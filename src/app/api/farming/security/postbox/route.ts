import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { callBox } from "@/lib/camera-postbox/client";
import { collectFromPostboxById } from "@/lib/camera-postbox/collector";
import { pairWithBox, postboxStatus, preparePairing, savePairing, unpairPostbox } from "@/lib/camera-postbox/service";
import { ConflictError } from "@/lib/errors";

/*
 * The camera post box (decisions 1226-1233): Farm › Security › Post box.
 * Owners and admins only (camera "set up" access), checked in every
 * service. Network calls to the post box happen between transactions,
 * never inside one.
 */

/** GET: whether a post box is paired, and what it last said. */
export const GET = route(async (request) => {
  const status = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => postboxStatus(tx));
  return json({ status });
});

/** POST `{ code }`: pairs with the post box the code is from. Audited. Then pushes the camera logins and collects once. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const prepared = await withFarmWork(request, body.organisationId, "read", (tx, { membership }) => {
    if (membership.organisation.demo) throw new ConflictError("The demo farm takes no camera uploads, so it can't have a post box.");
    return preparePairing(tx, body.code);
  });
  const answer = await pairWithBox(prepared.code, prepared.publicKey);
  const saved = await withFarmWork(request, body.organisationId, "read", (tx) => savePairing(tx, prepared.code, answer));
  const collected = await collectFromPostboxById(String(body.organisationId)).catch(() => null);
  const status = collected ? await withFarmWork(request, body.organisationId, "read", (tx) => postboxStatus(tx)) : saved;
  return json({ status }, { status: 201 });
});

/** DELETE: forgets the post box. Audited. Then tells the post box (if it can be reached) to forget Tohyee and its camera logins. */
export const DELETE = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const old = await withFarmWork(request, organisationId, "read", (tx) => unpairPostbox(tx));
  let told = false;
  if (old) told = await callBox(old, { method: "POST", path: "/v1/unpair" }).then(() => true, () => false);
  const status = await withFarmWork(request, organisationId, "read", (tx) => postboxStatus(tx));
  return json({ status, toldPostbox: told });
});
