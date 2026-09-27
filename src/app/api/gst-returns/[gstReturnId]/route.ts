import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getGstReturn } from "@/lib/reports/gst-return";

type Context = { params: Promise<{ gstReturnId: string }> };

/** GET: a filed GST return as it was filed, and each box that's changed since ("Changed since filed"). */
export const GET = route<Context>(async (request, context) => {
  const { gstReturnId } = await context.params;
  const gstReturn = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getGstReturn(tx, gstReturnId),
  );
  return json({ gstReturn });
});
