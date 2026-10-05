import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { printedDocument } from "@/lib/documents/print";
import { linkBeforeSending } from "@/lib/payments/links";

/** GET ?kind=invoice|credit_note|quote|purchase_order&id=: what the printed document shows. Stores and posts nothing. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  await linkBeforeSending(request, params.get("organisationId"), params.get("kind"), params.get("id"));
  const document = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    printedDocument(tx, params.get("kind"), params.get("id")),
  );
  return json({ document });
});
