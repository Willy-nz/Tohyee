import { json, readJson, route, withCrm } from "@/lib/api/http";
import { stopEnrolment } from "@/lib/crm/sequences";

type Context = { params: Promise<{ enrolmentId: string }> };

/** Stops a lead, person or deal's sequence: no more tasks are made (decision 497). */
export const POST = route<Context>(async (request, context) => {
  const { enrolmentId } = await context.params;
  const body = await readJson(request);
  const enrolment = await withCrm(request, body.organisationId, "write", (tx, { scope }) => stopEnrolment(tx, enrolmentId, scope));
  return json({ enrolment });
});
