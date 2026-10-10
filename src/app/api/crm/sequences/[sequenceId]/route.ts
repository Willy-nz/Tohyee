import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateSequence } from "@/lib/crm/sequences";

type Context = { params: Promise<{ sequenceId: string }> };

/** Changes a sequence's name, description or steps (only while nobody is part-way through), or switches it off (decision 497). */
export const PATCH = route<Context>(async (request, context) => {
  const { sequenceId } = await context.params;
  const body = await readJson(request);
  const sequence = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateSequence(tx, sequenceId, { name: body.name, description: body.description, steps: body.steps, isActive: body.isActive }),
  );
  return json({ sequence });
});
