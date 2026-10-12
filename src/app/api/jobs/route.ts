import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listJobs, serviceReminders } from "@/lib/projects/jobs";

/** GET: the jobs list with each job's next and last visit (JV1), and the services now due (JV8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    jobs: await listJobs(tx),
    reminders: await serviceReminders(tx, { today: params.get("today") || undefined }),
  }));
  return json(result);
});
