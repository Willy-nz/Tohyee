import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getRdFileContent } from "@/lib/rd/files";

type Context = { params: Promise<{ fileId: string }> };

/** GET: an R&D file, current or replaced (viewers and above). There's no DELETE: R&D files are kept (decision 45). */
export const GET = route<Context>(async (request, context) => {
  const { fileId } = await context.params;
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getRdFileContent(tx, fileId));
  return fileResponse(file, params.get("download") === "1");
});
