import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { signInduction } from "@/lib/safety/inductions";

/**
 * Signs an induction: for yourself (no `person`), or recorded for someone
 * without a login (`person`: name, company, phone). `inductionVersion` is
 * the version read; `acknowledged` must be true.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const signoff = await withFarmWork(request, body.organisationId, "read", (tx) => signInduction(tx, body));
  return json({ signoff }, { status: 201 });
});
