import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setSalesProcess } from "@/lib/crm/stages";

type Context = { params: Promise<{ recordTypeId: string }> };

/** Sets the stages an opportunity record type uses, or with `stageKeys: null` every active stage (CRMS7). Admins and owners only. */
export const PUT = route<Context>(async (request, context) => {
  const { recordTypeId } = await context.params;
  const body = await readJson(request);
  const salesProcess = await withCrm(request, body.organisationId, "admin", (tx) =>
    setSalesProcess(tx, recordTypeId, body.stageKeys === undefined ? null : body.stageKeys),
  );
  return json({ salesProcess });
});
