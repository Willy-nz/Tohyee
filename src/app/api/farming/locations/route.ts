import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { mySharing, stopSharing, updatePosition } from "@/lib/farming/locations";

/*
 * The signed-in person's own location sharing (#498 item 7, decisions
 * 1125-1134): whether it's on, their latest position while Tohyee is open,
 * and Stop sharing. Who it is comes from the session, never the request.
 */

/** GET: the signed-in person's sharing, or null. */
export const GET = route(async (request) => {
  const sharing = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => mySharing(tx));
  return json({ sharing });
});

/** PUT: replaces the latest position (`latitude`, `longitude`, `accuracyMetres`, `takenAt`, `shareId`). */
export const PUT = route(async (request) => {
  const body = await readJson(request, { maxBytes: 4096 });
  const result = await withFarmWork(request, body.organisationId, "read", (tx) =>
    updatePosition(tx, { shareId: body.shareId, latitude: body.latitude, longitude: body.longitude, accuracyMetres: body.accuracyMetres, takenAt: body.takenAt }),
  );
  return json(result);
});

/** DELETE: stops sharing and deletes the position. */
export const DELETE = route(async (request) => {
  const result = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => stopSharing(tx));
  return json(result);
});
