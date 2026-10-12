import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listVisits, scheduleVisit, visitsToIcs } from "@/lib/projects/jobs";

/**
 * GET: visits between `from` and `to` (JV2), optionally one person's
 * (`userId`, or `mine=1`) or one job's (`projectId`). `format=ics` downloads
 * them as a calendar file for Google or Microsoft calendar (JV9, one way).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const organisationId = params.get("organisationId");
  const visits = await withOrganisation(request, organisationId, "viewer", (tx, { auth }) =>
    listVisits(tx, {
      from: params.get("from"),
      to: params.get("to"),
      userId: params.get("mine") === "1" ? auth.user.id : params.get("userId"),
      projectId: params.get("projectId") || undefined,
    }),
  );
  if (params.get("format") === "ics") {
    return new Response(visitsToIcs(visits, String(organisationId)), {
      status: 200,
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="tohyee-visits.ics"' },
    });
  }
  return json({ visits });
});

/** Books a visit on a job for a member (JV2). Overlaps are allowed and flagged. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    scheduleVisit(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      projectId: body.projectId,
      taskId: body.taskId,
      userId: body.userId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      notes: body.notes,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
