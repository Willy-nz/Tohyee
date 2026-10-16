import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getIrdDocumentContent } from "@/lib/tax/income/ird-documents";

type Context = { params: Promise<{ documentId: string }> };

/** GET: an IRD document's file (owners and admins). */
export const GET = route<Context>(async (request, context) => {
  const { documentId } = await context.params;
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "admin", (tx) => getIrdDocumentContent(tx, documentId));
  return fileResponse(file, params.get("download") === "1");
});
