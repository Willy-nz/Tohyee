import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { addIrdDocument, listIrdDocuments, listProposals } from "@/lib/tax/income/ird-documents";

/** GET: IRD documents and proposed figures (owners and admins; ITX30, ITX33). `proposals=all` includes decided ones. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "admin", async (tx) => ({
    documents: await listIrdDocuments(tx),
    proposals: await listProposals(tx, { status: params.get("proposals") === "all" ? "all" : "waiting" }),
  }));
  return json(result);
});

/** POST (multipart form): adds an IRD file (`organisationId`, `idempotencyKey`, `file`, optional `incomeYear` and `note`). Owners and admins (ITX30). */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const result = await withOrganisation(request, form.get("organisationId"), "admin", (tx) =>
    addIrdDocument(tx, { idempotencyKey: form.get("idempotencyKey"), fileName: file.fileName, content: file.content, incomeYear: form.get("incomeYear"), note: form.get("note") }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
