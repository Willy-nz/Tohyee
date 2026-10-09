import { json, readJson, route, withCrm } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { mergeCompanies, mergePeople } from "@/lib/crm/duplicates";
import { ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * Merges `mergeId` into `keepId` (decision 494): `record` is "company" or
 * "person". Needs the bookkeeper role or higher, because the one merged away
 * is archived.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", async (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "bookkeeper")) throw new ForbiddenError("Merging needs the bookkeeper role or higher in this organisation.");
    if (body.record === "company") return mergeCompanies(tx, { keepId: body.keepId, mergeId: body.mergeId });
    if (body.record === "person") return mergePeople(tx, { keepId: body.keepId, mergeId: body.mergeId });
    throw new ValidationError("record must be company or person.");
  });
  return json(result);
});
