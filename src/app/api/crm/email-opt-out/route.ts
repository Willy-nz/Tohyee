import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setEmailOptOut } from "@/lib/crm/sales-email";

/** Marks a lead or person as not to be emailed, or clears it: `leadId` or `personId`, `optOut` (decision 496). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withCrm(request, body.organisationId, "write", (tx, { scope }) => setEmailOptOut(tx, { leadId: body.leadId, personId: body.personId, optOut: body.optOut }, scope));
  return json({ ok: true });
});
