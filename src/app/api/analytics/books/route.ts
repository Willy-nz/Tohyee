import { json, readJson, route } from "@/lib/api/http";
import { refreshBooks } from "@/lib/analytics/books";
import { analyticsMember } from "@/lib/analytics/http";

/** Copies the books and CRM into the organisation's analytics now and waits until it's done (AB8). Admins and owners. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  return json({ run: await refreshBooks(organisation, actor, "manual") });
});
