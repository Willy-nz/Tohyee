import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getAiApprovalSettings, saveAiApprovalSettings } from "@/lib/ai/action-approvals";

/** GET: whether a person approves the AI's voids, deletes and roll-backs (#697). Viewers and above. */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAiApprovalSettings(tx));
  return json(settings);
});

/** PUT { organisationId, required }: turns it on or off. Owners. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "owner", (tx) => saveAiApprovalSettings(tx, { required: body.required }));
  return json(settings);
});
