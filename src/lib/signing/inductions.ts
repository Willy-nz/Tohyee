import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { requireFarming } from "@/lib/farming/paddocks";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { PdfWriter } from "@/lib/pdf/writer";
import { inductionToRead, type InductionToRead } from "@/lib/safety/inductions";
import { appendEntry, requireSafetyRecorder } from "@/lib/safety/records";
import { type Audience, AUDIENCES, HAZARD_LEVEL_LABELS, SIGN_STATEMENT, type SignoffData } from "@/lib/safety/shared";
import { createSigningRequest, listSigningRequests, parseSigners, type SendContext, type SendResult } from "@/lib/signing/service";
import type { SigningRequestView } from "@/lib/signing/shared";
import { requireArray, requireIdempotencyKey } from "@/lib/validation";

/*
 * Safety inductions signed electronically (decision 1409). This builds on
 * the farm's sign-offs rather than keeping a second record: the induction,
 * the farm's hazards and its emergency details are written to a PDF (the
 * versions shown are kept with the request), each person gets their own
 * request, and when they sign, an induction sign-off is added to the
 * append-only safety records ("signed electronically"), naming the request
 * and the PDF's fingerprint. Their signing certificate stays with the
 * request.
 */

export type InductionDetails = { farmId: string; inductionId: string; inductionVersion: number; hazards: Array<{ id: string; version: number }>; emergencyVersion: number | null; audience: Audience };

/** The induction as it's signed: its sections, then the farm's active hazards and emergency details. */
export async function inductionPdf(toRead: InductionToRead, organisationName: string): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { induction, farm, hazards, emergency } = toRead;
  const writer = await PdfWriter.create({ title: `${induction.data.title}, ${farm.name}`, author: organisationName, footer: `${organisationName} · ${farm.name} · ${induction.data.title} version ${induction.version}` });
  writer.text(induction.data.title, { size: 18, bold: true, gap: 2 });
  writer.text(`${farm.name} · version ${induction.version}`, { muted: true, gap: 12 });
  for (const section of induction.data.sections) {
    writer.text(section.heading, { size: 12, bold: true, gap: 2 });
    writer.text(section.text, { gap: 10 });
  }
  writer.rule();
  writer.space(8);
  writer.text("This farm's hazards", { size: 13, bold: true, gap: 4 });
  if (!hazards.length) writer.text("None recorded.", { muted: true, gap: 8 });
  for (const hazard of hazards) {
    writer.text(`${hazard.title} (${HAZARD_LEVEL_LABELS[hazard.level]}${hazard.noGo ? ", no-go" : ""})`, { bold: true, gap: 1 });
    writer.text(hazard.controls ? `Controls: ${hazard.controls}` : "No controls recorded.", { gap: 6 });
  }
  writer.rule();
  writer.space(8);
  writer.text("Emergency details", { size: 13, bold: true, gap: 4 });
  if (!emergency) writer.text("None recorded.", { muted: true });
  else {
    const data = emergency.data;
    const lines: Array<[string, string | null]> = [
      ["Address", data.address],
      ["Entrance for emergency services", data.entrance],
      ["Assembly point", data.assemblyPoint],
      ["Contacts", data.contacts.map((contact) => `${contact.name}${contact.role ? ` (${contact.role})` : ""}: ${contact.phone}`).join("; ") || null],
      ["First aiders", data.firstAiders.join(", ") || null],
      ["Equipment", data.equipment.map((item) => `${item.what}: ${item.where}`).join("; ") || null],
      ["With no phone coverage", data.noCoveragePlan],
      ["Medical centre", data.medicalCentre],
      ["Notes", data.notes],
    ];
    for (const [label, value] of lines) if (value) writer.text(`${label}: ${value}`, { gap: 3 });
  }
  writer.space(10);
  writer.text(`By signing: "${SIGN_STATEMENT}"`, { bold: true });
  const safe = `${induction.data.title} ${farm.name}`.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 150) || "Induction";
  return { fileName: `${safe} v${induction.version}.pdf`, bytes: await writer.finish() };
}

export const inductionSourceId = (farmId: string, inductionId: string) => `${farmId}:${inductionId}`;

/**
 * Sends a farm's induction to people to sign, one request each (they each
 * sign their own induction). The version opened must still be the latest.
 */
export async function sendInductionForSigning(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; farmId: unknown; inductionId: unknown; inductionVersion: unknown; audience?: unknown; signers: unknown; message?: unknown; expiresInDays?: unknown },
  context: SendContext,
): Promise<SendResult[]> {
  await requireFarming(tx);
  requireSafetyRecorder(tx);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const toRead = await inductionToRead(tx, input.inductionId, input.farmId);
  if (String(input.inductionVersion ?? "") !== String(toRead.induction.version)) throw new ValidationError("The induction has changed since it was opened. Open it again, then send it.");
  const audience = (input.audience ?? "worker") as Audience;
  if (!AUDIENCES.includes(audience) || !toRead.induction.data.audiences.includes(audience)) throw new ValidationError("Choose who it's for, as the induction is for.");
  const people = parseSigners(input.signers, context.members);
  requireArray(input.signers, "Signers", 20);
  const organisation = await getOrganisationSettings(tx);
  const pdf = await inductionPdf(toRead, organisation.displayName);
  const details: InductionDetails = {
    farmId: toRead.farm.id,
    inductionId: toRead.induction.recordId,
    inductionVersion: toRead.induction.version,
    hazards: toRead.hazards.map((hazard) => ({ id: hazard.id, version: hazard.version })),
    emergencyVersion: toRead.emergency?.version ?? null,
    audience,
  };
  const results: SendResult[] = [];
  for (const [index, person] of people.entries()) {
    results.push(
      await createSigningRequest(
        tx,
        {
          source: input.source,
          idempotencyKey: `${key}.${index + 1}`.slice(0, 120),
          title: `${toRead.induction.data.title}, ${toRead.farm.name}`,
          sourceKind: "induction",
          sourceId: inductionSourceId(toRead.farm.id, toRead.induction.recordId),
          sourceDetails: details,
          fileName: pdf.fileName,
          bytes: pdf.bytes,
          signers: [{ name: person.name, email: person.email, roleLabel: person.roleLabel }],
          message: input.message,
          expiresInDays: input.expiresInDays,
        },
        context,
      ),
    );
  }
  return results;
}

/** A farm's induction requests, newest first. */
export async function listInductionRequests(tx: OrgTx, farmIdInput: unknown): Promise<SigningRequestView[]> {
  const farmId = String(farmIdInput ?? "");
  return (await listSigningRequests(tx, { sourceKind: "induction" })).filter((request) => request.sourceId?.startsWith(`${farmId}:`));
}

/** When the person has signed: their sign-off, as the farm's own records keep it (decision 1409). */
export async function recordInductionSignoff(tx: OrgTx, request: { id: string; source_details: unknown; document_sha256: string }, signer: { name: string; user_id: string | null }): Promise<void> {
  const details = request.source_details as InductionDetails;
  const data: SignoffData = {
    inductionId: details.inductionId,
    inductionVersion: details.inductionVersion,
    person: { userId: signer.user_id, name: signer.name, company: null, phone: null },
    audience: details.audience,
    signedHow: "esign",
    statement: SIGN_STATEMENT,
    hazards: details.hazards,
    emergencyVersion: details.emergencyVersion,
    signingRequestId: request.id,
    documentSha256: request.document_sha256,
  };
  await appendEntry<SignoffData>(tx, { kind: "induction_signoff", change: "created", farmId: details.farmId, happenedOn: todayIsoDate(), data: { ...data }, operationId: undefined });
}
