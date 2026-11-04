import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getContact } from "@/lib/contacts/service";
import { getQuote } from "@/lib/quotes/service";
import { publicOrigin } from "@/lib/auth/origin";
import { printedDocument } from "@/lib/documents/print";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { ConflictError } from "@/lib/errors";
import { getLogo } from "@/lib/organisations/logo";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { renderDocumentPdf } from "@/lib/pdf/documents";
import { sendQuoteForSigning } from "@/lib/signing/quotes";
import { listSigningRequests, loadMemberDirectory, signingEmailReadiness } from "@/lib/signing/service";

type Context = { params: Promise<{ quoteId: string }> };

/** GET: the quote's signing requests, whether email is set up, and who at the customer to suggest (their main person, or the contact's email). */
export const GET = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const quote = await getQuote(tx, quoteId);
    const contact = await getContact(tx, quote.contactId);
    const person = contact.primaryPerson?.email ? { name: contact.primaryPerson.name, email: contact.primaryPerson.email } : { name: contact.name, email: contact.email ?? "" };
    return { requests: await listSigningRequests(tx, { sourceKind: "quote", sourceId: quote.id }), email: await signingEmailReadiness(tx), suggested: person };
  });
  return json(result);
});

/**
 * POST `{ idempotencyKey, signers: [{ name, email }], message?, expiresInDays? }`:
 * sends a finalised quote's PDF for the customer to accept by signing
 * (QT9). The PDF is written as it prints, between two transactions.
 */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const loaded = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => {
    const printed = await printedDocument(tx, "quote", quoteId);
    if (printed.status !== "finalised") throw new ConflictError("Only a finalised quote that hasn't been accepted or declined can be sent to accept.");
    return { printed, logo: await getLogo(tx) };
  });
  const pdf = await renderDocumentPdf(loaded.printed, { logo: loaded.logo });
  const members = await loadMemberDirectory(parseOrganisationId(body.organisationId));
  const origin = await publicOrigin(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({
    sent: await sendQuoteForSigning(tx, quoteId, { ...body, idempotencyKey: body.idempotencyKey, signers: body.signers }, pdf, { origin, members }),
    organisationId: tx.organisationId,
  }));
  kickEmailOutbox(result.organisationId);
  return json(result.sent, { status: result.sent.created ? 201 : 200 });
});
