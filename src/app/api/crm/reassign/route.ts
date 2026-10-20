import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { applyReassignment, listReassignments, reassignOptions } from "@/lib/crm/reassign";

/** Who records can move between, and the last moves (decision 650) this person can see. */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => ({
    options: await reassignOptions(tx, scope),
    reassignments: await listReassignments(tx, scope),
  }));
  return json(result);
});

/**
 * Moves the records ticked in the preview: `fromUserId` (or "none"),
 * `toUserId`, `kinds`, `includeClosedDeals` and `ids` per kind.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) => applyReassignment(tx, body, scope));
  return json({ result });
});
