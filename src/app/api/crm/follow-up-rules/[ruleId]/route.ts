import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateFollowUpRule } from "@/lib/crm/follow-ups";

type Context = { params: Promise<{ ruleId: string }> };

/** Changes a rule's name, stage, days or task title, or switches it off or on (decision 495). */
export const PATCH = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  const rule = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateFollowUpRule(tx, ruleId, { kind: body.kind, name: body.name, stageKey: body.stageKey, days: body.days, taskTitle: body.taskTitle, isActive: body.isActive }),
  );
  return json({ rule });
});
