import { json, readJson, route, withCrm } from "@/lib/api/http";
import { reviewDuplicate } from "@/lib/crm/duplicates";

/** Marks a suggested pair (decision 494): `record`, `firstId`, `secondId`, `decision` ("not_duplicate" or "same_customer"). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withCrm(request, body.organisationId, "write", (tx) =>
    reviewDuplicate(tx, { record: body.record, firstId: body.firstId, secondId: body.secondId, decision: body.decision }),
  );
  return json({ ok: true });
});
