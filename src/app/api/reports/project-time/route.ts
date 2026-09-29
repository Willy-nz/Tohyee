import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { timeReport } from "@/lib/projects/service";

/** GET: time entries from `from` to `to`, optionally for one `userId`, `projectId` or `taskId`, by person, project and task (PJ11). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    timeReport(tx, { from: params.get("from"), to: params.get("to"), userId: params.get("userId"), projectId: params.get("projectId"), taskId: params.get("taskId") }),
  );
  return json({ report });
});
