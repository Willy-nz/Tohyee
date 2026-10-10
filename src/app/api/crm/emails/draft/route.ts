import { json, readJson, route, withCrm } from "@/lib/api/http";
import { draftSalesEmail } from "@/lib/crm/sales-email";

/**
 * What an email to a lead, person or deal's contact would say, from a
 * template or blank, and which of your mailboxes can send it (decision 496).
 * Nothing is sent.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const draft = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    draftSalesEmail(tx, { leadId: body.leadId, personId: body.personId, opportunityId: body.opportunityId, templateId: body.templateId }, scope),
  );
  return json({ draft });
});
