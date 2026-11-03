import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { getOrganisationSettings, gstRegistrationImpact } from "@/lib/organisations/settings";

type Context = { params: Promise<{ organisationId: string }> };

/**
 * The months a GST registration change would reach (#546, GSR8), before it's
 * saved: ?registered=true|false&from=YYYY-MM-DD&until=YYYY-MM-DD. Read only.
 */
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const params = searchParams(request);
  const registeredText = params.get("registered");
  if (registeredText !== "true" && registeredText !== "false") throw new ValidationError("registered must be true or false.");
  const registered = registeredText === "true";
  const date = (name: string, label: string) => {
    const value = params.get(name);
    return !registered || value === null || value === "" ? null : parseIsoDate(value, label);
  };
  const next = { registered, from: date("from", "The date GST registration starts"), until: date("until", "The date GST registration ended") };
  const periods = await withOrganisation(request, organisationId, "admin", async (tx) => gstRegistrationImpact(tx, await getOrganisationSettings(tx), next));
  return json({ periods });
});
