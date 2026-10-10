import { json, readJson, route, withCrm } from "@/lib/api/http";
import { runFollowUpRules } from "@/lib/crm/follow-ups";

/** Runs the active rules now, or one (`ruleId`), instead of waiting for the next check (decision 495). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "admin", (tx) => runFollowUpRules(tx, { ruleId: body.ruleId ?? undefined }));
  return json(result);
});
