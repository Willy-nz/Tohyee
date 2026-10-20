import { json, readJson, route, withCrm } from "@/lib/api/http";
import { previewReassignment } from "@/lib/crm/reassign";

/** Every record that would move from `fromUserId` (or "none") to `toUserId` (decision 650). Changes nothing. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const preview = await withCrm(request, body.organisationId, "write", (tx, { scope }) => previewReassignment(tx, body, scope));
  return json({ preview });
});
