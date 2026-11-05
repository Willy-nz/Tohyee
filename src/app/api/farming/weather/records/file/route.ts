import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getPermissionFile } from "@/lib/weather/service";

/** GET: the attached MetService permission, to open or download. Admins. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const file = await withOrganisation(request, query.get("organisationId"), "admin", (tx) => getPermissionFile(tx));
  return fileResponse(file, query.get("download") === "1");
});
