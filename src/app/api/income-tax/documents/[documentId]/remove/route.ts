import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeIrdDocument } from "@/lib/tax/income/ird-documents";

type Context = { params: Promise<{ documentId: string }> };

/** POST: removes an IRD document with a reason; the history keeps it (owners and admins; ITX30). */
export const POST = route<Context>(async (request, context) => {
  const { documentId } = await context.params;
  const body = await readJson(request);
  const document = await withOrganisation(request, body.organisationId, "admin", (tx) => removeIrdDocument(tx, documentId, { reason: body.reason }));
  return json({ document });
});
