import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setQuota } from "@/lib/crm/forecast";

/** Sets or (with no amount) clears an owner's quota for a month, in the base currency (CRMS10). Admins and owners only. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const quota = await withCrm(request, body.organisationId, "admin", (tx) =>
    setQuota(tx, { ownerUserId: body.ownerUserId, month: body.month, amount: body.amount }),
  );
  return json({ quota });
});
