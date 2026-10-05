import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { printedDocument } from "@/lib/documents/print";
import { loadStatement, parseStatementOptions } from "@/lib/email/documents";
import { statementFromParams } from "@/lib/email/params";
import { getLogo } from "@/lib/organisations/logo";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { linkBeforeSending } from "@/lib/payments/links";
import { renderDocumentPdf, renderStatementPdf } from "@/lib/pdf/documents";
import { requireId } from "@/lib/validation";

/**
 * GET ?kind=invoice|credit_note|quote|purchase_order&id=, or
 * kind=statement&id=<customer>&statementKind=...: the PDF the server
 * attaches to emails, to look at or download (`download=true`). Viewers and
 * above, like the print pages. The data is loaded in the transaction; the
 * PDF is written after it.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const kind = params.get("kind");
  await linkBeforeSending(request, params.get("organisationId"), kind, params.get("id"));
  const loaded = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const logo = await getLogo(tx);
    if (kind === "statement") {
      const statement = await loadStatement(tx, requireId(params.get("id"), "id"), parseStatementOptions(statementFromParams(params)));
      const settings = await getOrganisationSettings(tx);
      return { statement, organisation: { name: settings.displayName, postalAddress: settings.postalAddress }, printed: null, logo };
    }
    return { printed: await printedDocument(tx, kind, params.get("id")), statement: null, organisation: null, logo };
  });
  const pdf = loaded.printed
    ? await renderDocumentPdf(loaded.printed, { logo: loaded.logo })
    : await renderStatementPdf(loaded.statement!, loaded.organisation!, { logo: loaded.logo });
  const disposition = params.get("download") === "true" ? "attachment" : "inline";
  return new Response(Buffer.from(pdf.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${disposition}; filename="${pdf.fileName.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
