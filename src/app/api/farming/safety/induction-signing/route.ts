import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { canRecordSafety } from "@/lib/safety/records";
import { listInductionRequests, sendInductionForSigning } from "@/lib/signing/inductions";
import { loadMemberDirectory, signingEmailReadiness } from "@/lib/signing/service";

/** GET `?farmId=`: the farm's inductions sent to sign electronically, whether email is set up, and the members. Those who keep safety records only. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const organisationId = parseOrganisationId(params.get("organisationId"));
  const result = await withFarmWork(request, organisationId, "read", async (tx) =>
    canRecordSafety(tx) ? { canSend: true, requests: await listInductionRequests(tx, params.get("farmId")), email: await signingEmailReadiness(tx) } : { canSend: false, requests: [], email: { ready: false, reason: null } },
  );
  const members = result.canSend ? [...(await loadMemberDirectory(organisationId)).entries()].map(([email, member]) => ({ userId: member.userId, name: member.name, email })) : [];
  return json({ ...result, members });
});

/** POST `{ idempotencyKey, farmId, inductionId, inductionVersion, audience?, signers, message?, expiresInDays? }`: one request per person (decision 1409). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  const members = await loadMemberDirectory(organisationId);
  const origin = await publicOrigin(request);
  const result = await withFarmWork(request, organisationId, "read", async (tx) => ({
    sent: await sendInductionForSigning(tx, { ...body, idempotencyKey: body.idempotencyKey, farmId: body.farmId, inductionId: body.inductionId, inductionVersion: body.inductionVersion, signers: body.signers }, { origin, members }),
    organisationId: tx.organisationId,
  }));
  kickEmailOutbox(result.organisationId);
  return json({ sent: result.sent }, { status: 201 });
});
