import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { listDuplicates } from "@/lib/crm/duplicates";

/**
 * Likely duplicate companies and people (decision 494), and whether this
 * person can merge them: merging archives a company, so it needs the
 * bookkeeper role or higher.
 */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { membership }) => ({
    pairs: await listDuplicates(tx),
    canMerge: roleAtLeast(membership.role, "bookkeeper"),
  }));
  return json(result);
});
