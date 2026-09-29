import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { printedDocument } from "@/lib/documents/print";

/** GET ?kind=invoice|credit_note|quote&id=: what the printed document shows. Stores and posts nothing. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const document = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    printedDocument(tx, params.get("kind"), params.get("id")),
  );
  return json({ document });
});
