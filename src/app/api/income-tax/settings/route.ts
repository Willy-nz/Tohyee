import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateIncomeTaxSettings } from "@/lib/tax/income/service";

/** PUT: company or individual, and a tax agent's extension of time (owners and admins; ITX1, ITX10). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => updateIncomeTaxSettings(tx, { taxpayerType: body.taxpayerType, agentExtension: body.agentExtension, version: body.version }));
  return json({ settings });
});
