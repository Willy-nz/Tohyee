import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createLead, listLeads } from "@/lib/crm/leads";

/**
 * Leads (decision 492): `status` (new, working, unqualified, converted, or
 * "open" for new and working), `search`, `needsReview`, `ownerUserId` ("none"
 * for unassigned). A sales rep sees their own; a manager also their teams'
 * and unassigned ones.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const leads = await withCrm(request, params.get("organisationId"), "read", (tx, { scope }) =>
    listLeads(tx, {
      status: params.get("status"),
      search: params.get("search"),
      needsReview: params.get("needsReview"),
      ownerUserId: params.get("ownerUserId"),
      scope,
    }),
  );
  return json({ leads });
});

/** Adds a lead typed in. Its owner is whoever adds it unless `ownerUserId` says otherwise. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    createLead(
      tx,
      {
        source: body.source,
        idempotencyKey: body.idempotencyKey,
        firstName: body.firstName,
        lastName: body.lastName,
        companyName: body.companyName,
        email: body.email,
        phone: body.phone,
        jobTitle: body.jobTitle,
        description: body.description,
        sourceDetail: body.sourceDetail,
        ownerUserId: body.ownerUserId,
      },
      scope,
    ),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
