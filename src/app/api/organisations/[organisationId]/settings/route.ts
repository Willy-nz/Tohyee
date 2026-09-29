import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import {
  getOrganisationSettings,
  syncOrganisationRegistry,
  updateOrganisationSettings,
} from "@/lib/organisations/settings";

type Context = { params: Promise<{ organisationId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const settings = await withOrganisation(request, organisationId, "viewer", (tx) =>
    getOrganisationSettings(tx),
  );
  return json({ settings });
});

export const PATCH = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const body = await readJson(request);
  const settings = await withOrganisation(request, organisationId, "admin", (tx) =>
    updateOrganisationSettings(tx, {
      displayName: body.displayName,
      baseCurrency: body.baseCurrency,
      financialYearEndMonth: body.financialYearEndMonth,
      gstBasis: body.gstBasis,
      advancedFeatures: body.advancedFeatures,
      crmEnabled: body.crmEnabled,
      allowNegativeStock: body.allowNegativeStock,
    }),
  );
  await syncOrganisationRegistry(settings);
  return json({ settings });
});
