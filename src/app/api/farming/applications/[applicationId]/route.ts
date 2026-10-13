import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeApplication } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ applicationId: string }> };

/** Removes an application recorded by mistake. Refused while a spreading bill is linked to it. */
export const DELETE = route<Context>(async (request, context) => {
  const { applicationId } = await context.params;
  const report = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeApplication(tx, applicationId));
  return json({ report });
});
