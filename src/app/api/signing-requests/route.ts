import { json, MAX_FILE_JSON_BYTES, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { decodePdf } from "@/lib/signing/employment";
import { canSendKind, createSigningRequest, listSigningRequests, loadMemberDirectory, signingEmailReadiness } from "@/lib/signing/service";

/** GET: signing requests the person may see (`sourceKind`, `sourceId`, `state` to filter), whether signing emails can be sent, and (for those who can send) the members. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const organisationId = parseOrganisationId(params.get("organisationId"));
  const result = await withOrganisation(request, organisationId, "farm_worker", async (tx) => ({
    requests: await listSigningRequests(tx, { sourceKind: params.get("sourceKind"), sourceId: params.get("sourceId"), state: params.get("state") }),
    email: await signingEmailReadiness(tx),
    canSend: await canSendKind(tx, "upload"),
  }));
  const members = params.get("members") === "true" && result.canSend ? [...(await loadMemberDirectory(organisationId)).entries()].map(([email, member]) => ({ userId: member.userId, name: member.name, email })) : [];
  return json({ ...result, members });
});

/**
 * POST `{ idempotencyKey, title, fileName, contentBase64, signers, signingOrder?, message?, expiresInDays?, remindEveryDays? }`:
 * sends any PDF to one or more people to sign (decision 1410).
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES * 2 });
  const organisationId = parseOrganisationId(body.organisationId);
  const members = await loadMemberDirectory(organisationId);
  const origin = await publicOrigin(request);
  const result = await withOrganisation(request, organisationId, "bookkeeper", async (tx) => ({
    sent: await createSigningRequest(
      tx,
      {
        source: body.source,
        idempotencyKey: body.idempotencyKey,
        title: body.title,
        sourceKind: "upload",
        sourceId: null,
        fileName: typeof body.fileName === "string" ? body.fileName : "document.pdf",
        bytes: decodePdf(body.contentBase64),
        signers: body.signers,
        signingOrder: body.signingOrder,
        message: body.message,
        expiresInDays: body.expiresInDays,
        remindEveryDays: body.remindEveryDays,
        replacesRequestId: body.replacesRequestId,
      },
      { origin, members },
    ),
    organisationId: tx.organisationId,
  }));
  kickEmailOutbox(result.organisationId);
  return json(result.sent, { status: result.sent.created ? 201 : 200 });
});
