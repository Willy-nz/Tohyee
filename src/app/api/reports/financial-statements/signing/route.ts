import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { parseIsoDate } from "@/lib/dates";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { canSendKind, listSigningRequests, loadMemberDirectory, signingEmailReadiness } from "@/lib/signing/service";
import { notesAreDrafts, sendYearEndForSigning } from "@/lib/signing/year-end";

/** GET `?yearEnd=`: that year's signing requests and signed copies, whether email is set up, the members (to pick signers) and whether the notes are drafts. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const organisationId = parseOrganisationId(params.get("organisationId"));
  const yearEnd = parseIsoDate(params.get("yearEnd"), "yearEnd");
  const result = await withOrganisation(request, organisationId, "viewer", async (tx) => ({
    requests: await listSigningRequests(tx, { sourceKind: "year_end", sourceId: yearEnd }),
    email: await signingEmailReadiness(tx),
    notesAreDrafts: await notesAreDrafts(tx),
    canSend: await canSendKind(tx, "year_end"),
  }));
  // Members are offered as signers only to those who can send.
  const members = result.canSend ? [...(await loadMemberDirectory(organisationId)).entries()].map(([email, member]) => ({ userId: member.userId, name: member.name, email })) : [];
  return json({ ...result, members });
});

/** POST `{ idempotencyKey, yearEnd, signers, signingOrder?, message?, expiresInDays?, replacesRequestId? }`: sends the year's statements to sign (decision 1407). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  const members = await loadMemberDirectory(organisationId);
  const origin = await publicOrigin(request);
  const result = await withOrganisation(request, organisationId, "bookkeeper", async (tx) => ({
    sent: await sendYearEndForSigning(tx, { ...body, idempotencyKey: body.idempotencyKey, yearEnd: body.yearEnd, signers: body.signers }, { origin, members }),
    organisationId: tx.organisationId,
  }));
  kickEmailOutbox(result.organisationId);
  return json(result.sent, { status: result.sent.created ? 201 : 200 });
});
