import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setRepeatingStatus } from "@/lib/repeating/service";

type Context = { params: Promise<{ repeatingInvoiceId: string }> };

/** Pauses (active -> paused), resumes (paused -> active) or ends a template. Ending is final. */
export const POST = route<Context>(async (request, context) => {
  const { repeatingInvoiceId } = await context.params;
  const body = await readJson(request);
  const repeatingInvoice = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setRepeatingStatus(tx, repeatingInvoiceId, body.status),
  );
  return json({ repeatingInvoice });
});
