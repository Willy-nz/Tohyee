import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { pdfResponse } from "@/lib/signing/http";
import { readSigningFile } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** GET `?which=document|signed`: the document as sent, or the signed copy. `download=true` saves it. */
export const GET = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const params = searchParams(request);
  const which = params.get("which") === "signed" ? "signed" : "document";
  const file = await withOrganisation(request, params.get("organisationId"), "farm_worker", (tx) => readSigningFile(tx, requestId, which));
  return pdfResponse(file, params.get("download") === "true");
});
