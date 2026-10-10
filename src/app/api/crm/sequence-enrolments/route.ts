import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { ForbiddenError } from "@/lib/errors";
import { enrol, listEnrolments } from "@/lib/crm/sequences";

/**
 * Who is in which sequence (decision 497): for one lead, person or deal, or
 * for a whole sequence (admins and owners, on CRM › Sequences).
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const target = { leadId: query.get("leadId") ?? undefined, personId: query.get("personId") ?? undefined, opportunityId: query.get("opportunityId") ?? undefined };
  const enrolments = await withCrm(request, query.get("organisationId"), "read", (tx, { scope }) => {
    const whole = target.leadId === undefined && target.personId === undefined && target.opportunityId === undefined;
    if (whole && !scope.canAdmin) throw new ForbiddenError("Seeing everyone in a sequence needs the admin role or higher.");
    return listEnrolments(tx, { ...target, sequenceId: query.get("sequenceId") ?? undefined }, scope);
  });
  return json({ enrolments });
});

/** Adds a lead, person or deal to a sequence: `sequenceId` and one of `leadId`, `personId`, `opportunityId`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const enrolment = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    enrol(tx, { sequenceId: body.sequenceId, leadId: body.leadId, personId: body.personId, opportunityId: body.opportunityId }, scope),
  );
  return json({ enrolment }, { status: 201 });
});
