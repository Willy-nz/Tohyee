import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setRenewals } from "@/lib/crm/account-plans";

type Context = { params: Promise<{ opportunityId: string }> };

/** Sets the deal's `renewalDate` and its products' (`lines` [{ lineOrder, renewalDate }]); decision 654. */
export const PUT = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const renewals = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    setRenewals(tx, opportunityId, { renewalDate: body.renewalDate, lines: body.lines }, scope),
  );
  return json({ renewals });
});
