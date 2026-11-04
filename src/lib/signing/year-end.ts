import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { getStatementNotes } from "@/lib/reports/financial-statements";
import { getPerformanceSettings } from "@/lib/reports/performance-report";
import { yearEndReportPdf } from "@/lib/reports/performance-report-pdf";
import { parseIsoDate } from "@/lib/dates";
import { createSigningRequest, type SendContext, type SendResult } from "@/lib/signing/service";

/*
 * Year-end accounts signed by the directors or officers (decision 1407):
 * the year's financial statements PDF (or performance report), exactly as
 * it downloads at the moment it's sent, goes to the people who sign them.
 * The signed copy is kept with that year (source_id is the year-end date).
 * One open request per year; a new version (the figures or notes changed)
 * replaces the open one, which is voided.
 */

export async function sendYearEndForSigning(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; yearEnd: unknown; signers: unknown; signingOrder?: unknown; message?: unknown; expiresInDays?: unknown; replacesRequestId?: unknown },
  context: SendContext,
): Promise<SendResult> {
  const yearEnd = parseIsoDate(input.yearEnd, "Financial year ending");
  const open = await tx.query<{ id: string; idempotency_key: string }>(
    "select id::text, idempotency_key from signing_requests where source_kind = 'year_end' and source_id = $1 and status = 'sent' and expires_at > now()",
    [yearEnd],
  );
  const replay = open.rows[0] && open.rows[0].idempotency_key === input.idempotencyKey;
  if (open.rows[0] && !replay && String(input.replacesRequestId ?? "") !== open.rows[0].id) {
    throw new ConflictError("The statements for this year are already out for signing. Send a new version to replace that request, or void it first.");
  }
  const pdf = await yearEndReportPdf(tx, { yearEnd });
  const [organisation, performance] = await Promise.all([getOrganisationSettings(tx), getPerformanceSettings(tx)]);
  const what = performance.format === "special_purpose" ? "Financial statements" : "Performance report";
  const [year] = yearEnd.split("-");
  return createSigningRequest(
    tx,
    {
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      title: `${what} for the year ended ${new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${yearEnd}T00:00:00Z`))} ${year}, ${organisation.displayName}`,
      sourceKind: "year_end",
      sourceId: yearEnd,
      fileName: pdf.fileName,
      bytes: pdf.bytes,
      signers: input.signers,
      signingOrder: input.signingOrder,
      message: input.message,
      expiresInDays: input.expiresInDays,
      replacesRequestId: replay ? undefined : input.replacesRequestId,
    },
    context,
  );
}

/** Whether the year's notes are still Tohyee's drafts (the PDF says so), for the warning before sending. */
export async function notesAreDrafts(tx: OrgTx): Promise<boolean> {
  return !(await getStatementNotes(tx)).saved;
}
