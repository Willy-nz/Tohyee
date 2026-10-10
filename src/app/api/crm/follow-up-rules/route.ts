import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createFollowUpRule, listFollowUpRules, listFollowUpRuns } from "@/lib/crm/follow-ups";

/** The follow-up rules and their latest runs (decision 495). Admins and owners only. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const result = await withCrm(request, query.get("organisationId"), "admin", async (tx) => ({
    rules: await listFollowUpRules(tx),
    runs: await listFollowUpRuns(tx, { ruleId: query.get("ruleId") ?? undefined, limit: 100 }),
  }));
  return json(result);
});

/** Adds a rule: `kind`, `name`, `days`, and `stageKey` for a deal-stage rule; `taskTitle` is optional. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const rule = await withCrm(request, body.organisationId, "admin", (tx) =>
    createFollowUpRule(tx, { kind: body.kind, name: body.name, stageKey: body.stageKey, days: body.days, taskTitle: body.taskTitle, isActive: body.isActive }),
  );
  return json({ rule }, { status: 201 });
});
