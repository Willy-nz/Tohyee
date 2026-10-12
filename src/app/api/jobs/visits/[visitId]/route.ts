import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { confirmVisitHours, finishVisit, getVisit, rescheduleVisit, signVisit, startVisit, tickVisitCheck } from "@/lib/projects/jobs";

type Context = { params: Promise<{ visitId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { visitId } = await context.params;
  const visit = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getVisit(tx, visitId));
  return json({ visit });
});

/** Moves, reassigns or cancels (`cancel: true`) a visit that hasn't started (JV2). */
export const PATCH = route<Context>(async (request, context) => {
  const { visitId } = await context.params;
  const body = await readJson(request);
  const visit = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    rescheduleVisit(tx, visitId, { startsAt: body.startsAt, endsAt: body.endsAt, userId: body.userId, notes: body.notes, cancel: body.cancel }),
  );
  return json({ visit });
});

/**
 * Works a visit (the visit's own person, or an admin): `action` is start,
 * finish (`finishAnyway` for unticked checklist items), confirm (the hours
 * into project time, `minutes` to change them), check (`item`, `ticked`) or
 * sign (`signedBy`) (JV3, JV5, JV6).
 */
export const POST = route<Context>(async (request, context) => {
  const { visitId } = await context.params;
  const body = await readJson(request);
  const visit = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { membership }) => {
    const role = membership.role;
    switch (body.action) {
      case "start":
        return startVisit(tx, role, visitId, { at: body.at });
      case "finish":
        return finishVisit(tx, role, visitId, { at: body.at, finishAnyway: body.finishAnyway });
      case "confirm":
        return (await confirmVisitHours(tx, role, visitId, { minutes: body.minutes, idempotencyKey: body.idempotencyKey, source: body.source })).visit;
      case "check":
        return tickVisitCheck(tx, role, visitId, { item: body.item, ticked: body.ticked });
      case "sign":
        return signVisit(tx, role, visitId, { signedBy: body.signedBy });
      default:
        throw new ValidationError("action must be start, finish, confirm, check or sign.");
    }
  });
  return json({ visit });
});
