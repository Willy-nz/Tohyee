import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createSequence, listSequences } from "@/lib/crm/sequences";

/** Sequences (decision 497): everyone in the CRM sees the ones switched on; admins also see the others. */
export const GET = route(async (request) => {
  const sequences = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx, { scope }) =>
    listSequences(tx, { includeInactive: scope.canAdmin }),
  );
  return json({ sequences });
});

/** Adds a sequence: `name`, `description`, and `steps` [{ dayOffset, kind, title, templateId }]. Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const sequence = await withCrm(request, body.organisationId, "admin", (tx) => createSequence(tx, { name: body.name, description: body.description, steps: body.steps }));
  return json({ sequence }, { status: 201 });
});
