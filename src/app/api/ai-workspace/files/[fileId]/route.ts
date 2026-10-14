import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { archiveAiFile } from "@/lib/ai-workspace/files";

type Context = { params: Promise<{ fileId: string }> };

/** Archives a file so the AI no longer sees it. Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { fileId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => archiveAiFile(tx, fileId));
  return json({ archived: true });
});
