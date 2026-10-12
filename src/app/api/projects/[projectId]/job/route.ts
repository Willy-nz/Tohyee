import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getJobDetails, setJobDetails } from "@/lib/projects/jobs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const job = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getJobDetails(tx, projectId));
  return json({ job });
});

/** Makes a project a job, or changes its site, contact on site, service interval and checklist (JV1, JV5, JV8). */
export const PUT = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const job = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setJobDetails(tx, projectId, {
      isJob: body.isJob,
      siteAddress: body.siteAddress,
      siteContact: body.siteContact,
      serviceIntervalMonths: body.serviceIntervalMonths,
      checklistItems: body.checklistItems,
    }),
  );
  return json({ job });
});
