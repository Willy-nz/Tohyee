import { json, MAX_FILE_JSON_BYTES, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { listEmploymentAgreements, sendEmploymentAgreement } from "@/lib/signing/employment";
import { loadMemberDirectory, signingEmailReadiness } from "@/lib/signing/service";

type Context = { params: Promise<{ employeeId: string }> };

/** GET: the employee's agreements sent to sign, whether email is set up, and the members (to sign for the employer). Payroll access only. */
export const GET = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const organisationId = parseOrganisationId(searchParams(request).get("organisationId"));
  const result = await withPayrollAccess(request, organisationId, async (tx) => ({ requests: await listEmploymentAgreements(tx, employeeId), email: await signingEmailReadiness(tx) }));
  const members = [...(await loadMemberDirectory(organisationId)).entries()].map(([email, member]) => ({ userId: member.userId, name: member.name, email }));
  return json({ ...result, members });
});

/** POST `{ idempotencyKey, fileName, contentBase64, signers, signingOrder?, message?, expiresInDays?, remindEveryDays? }`: sends an agreement to sign (decision 1408). */
export const POST = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES * 2 });
  const organisationId = parseOrganisationId(body.organisationId);
  const members = await loadMemberDirectory(organisationId);
  const origin = await publicOrigin(request);
  const result = await withPayrollAccess(request, organisationId, async (tx) => ({
    sent: await sendEmploymentAgreement(tx, employeeId, { ...body, idempotencyKey: body.idempotencyKey, signers: body.signers }, { origin, members }),
    organisationId: tx.organisationId,
  }));
  kickEmailOutbox(result.organisationId);
  return json(result.sent, { status: result.sent.created ? 201 : 200 });
});
