import { json, readJson, route, withCrm } from "@/lib/api/http";
import { convertLead } from "@/lib/crm/leads";

type Context = { params: Promise<{ leadId: string }> };

/**
 * Converts a lead (decision 492): `contactId` (else a new prospect company),
 * `personId` (else a new person), and unless `opportunity` is false a new
 * opportunity (`opportunityName`, `amount`, `closeDate`).
 */
export const POST = route<Context>(async (request, context) => {
  const { leadId } = await context.params;
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    convertLead(
      tx,
      leadId,
      {
        contactId: body.contactId,
        personId: body.personId,
        opportunity: body.opportunity,
        opportunityName: body.opportunityName,
        amount: body.amount,
        closeDate: body.closeDate,
      },
      scope,
    ),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
