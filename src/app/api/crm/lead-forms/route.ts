import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { createLeadForm, formSnippet, listLeadForms } from "@/lib/crm/lead-intake";

/**
 * The organisation's web lead forms (decision 493), with the HTML to put on
 * a website when remote access gives the server a public address. Admins.
 */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const forms = await withCrm(request, organisationId, "admin", (tx) => listLeadForms(tx));
  const address = await remoteAccessAddress();
  return json({
    publicAddress: address,
    forms: forms.map((form) => ({ ...form, snippet: address && organisationId ? formSnippet(address, organisationId, form) : null })),
  });
});

/** Adds a form: `name`, optional `thankYouUrl`. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const form = await withCrm(request, body.organisationId, "admin", (tx) => createLeadForm(tx, { name: body.name, thankYouUrl: body.thankYouUrl }));
  return json({ form }, { status: 201 });
});
