"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { SalesLinesTable } from "@/components/documents/lines-table";
import { DocumentExportFlags } from "@/components/exports";
import { useApiData } from "@/components/hooks";
import { RepeatingStatusBadge } from "@/components/repeating/repeating-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import { describeSchedule } from "@/lib/repeating/schedule";
import type { RepeatingInvoice, RepeatingRun, RunResult } from "@/lib/repeating/service";

const OUTCOMES: Record<RepeatingRun["outcome"], string> = {
  draft: "Saved as a draft",
  approved: "Approved",
  approval_refused: "Left as a draft",
};

/** Run now, pause, resume and end (RI2, RI7). */
function RepeatingActions({
  organisationId,
  template,
  onChanged,
}: {
  organisationId: string;
  template: RepeatingInvoice;
  onChanged: (template: RepeatingInvoice, message: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function runNow() {
    void run(async () => {
      const result = await api<{ result: RunResult; repeatingInvoice: RepeatingInvoice }>(
        `/api/repeating-invoices/${template.id}/run`,
        { method: "POST", body: { organisationId } },
      );
      const { made, approved, refused, failed } = result.result;
      const parts = [
        made === 0 ? "No invoices were due." : `Made ${made} invoice${made === 1 ? "" : "s"}.`,
        approved ? `${approved} approved.` : "",
        refused ? `${refused} left as draft (see the history).` : "",
        failed ? "One date couldn't be made; see the message above the history." : "",
      ];
      onChanged(result.repeatingInvoice, parts.filter(Boolean).join(" "));
    });
  }

  function setStatus(status: "active" | "paused" | "ended", confirmText: string | null, done: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    void run(async () => {
      const result = await api<{ repeatingInvoice: RepeatingInvoice }>(`/api/repeating-invoices/${template.id}/status`, {
        method: "POST",
        body: { organisationId, status },
      });
      onChanged(result.repeatingInvoice, done);
    });
  }

  if (template.status === "ended") return null;
  return (
    <Card
      title="Actions"
      description="Run now makes any invoices due up to today, the same as the hourly job. Pausing stops new invoices; resuming carries on from today (dates while it was paused aren't made). Ending is final."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        {template.status === "active" ? (
          <>
            <Button onClick={runNow} disabled={busy}>
              {busy ? "Working…" : "Run now"}
            </Button>
            <Button variant="secondary" onClick={() => setStatus("paused", null, "Paused. No invoices are made until it's resumed.")} disabled={busy}>
              Pause
            </Button>
          </>
        ) : (
          <Button
            onClick={() =>
              setStatus("active", "Resume from today? Dates that fell while it was paused won't be made.", "Resumed from today.")
            }
            disabled={busy}
          >
            Resume
          </Button>
        )}
        <Button variant="secondary" onClick={() => router.push(`/operations/repeating-invoices/${template.id}/edit`)} disabled={busy}>
          Change
        </Button>
        <Button
          variant="danger"
          onClick={() => setStatus("ended", "End this repeating invoice? No more invoices will be made, and it can't be started again.", "Ended.")}
          disabled={busy}
        >
          End
        </Button>
      </div>
    </Card>
  );
}

function RepeatingView({ organisationId, id }: { organisationId: string; id: string }) {
  const { can } = useWorkspace();
  const customSetup = useCustomFields(organisationId);
  const details = useApiData<{ repeatingInvoice: RepeatingInvoice }>(`/api/repeating-invoices/${encodeURIComponent(id)}`, { organisationId });
  const [updated, setUpdated] = useState<RepeatingInvoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/repeating-invoices">Back to repeating invoices</Link>
        </p>
      </>
    );
  }
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const template = updated ?? details.data.repeatingInvoice;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {template.lastError ? (
        <Notice tone="warning">
          The last run stopped at {template.lastError} It will try that date again next run.
        </Notice>
      ) : null}
      <Card
        title={`Repeating invoice to ${template.contactName}`}
        description={`${describeSchedule(template)} · ${AMOUNTS_MODE_LABELS[template.amountsMode]} · ${template.currencyCode}`}
        actions={<RepeatingStatusBadge status={template.status} />}
      >
        <div className={ui.grid3}>
          <Stat label="First invoice date" value={formatDate(template.startDate)} />
          <Stat label="End date" value={template.endDate ? formatDate(template.endDate) : "None"} />
          <Stat label="Next invoice" value={template.nextDate ? formatDate(template.nextDate) : "—"} />
          <Stat
            label="Due"
            value={template.dueRule === "terms" ? "Customer's payment terms" : `${template.dueDays} days after the invoice date`}
          />
          <Stat label="Each invoice is" value={template.saveAs === "approve" ? "Approved" : "Saved as a draft"} />
          <Stat label="Reference" value={template.reference ?? "—"} />
        </div>
        <DocumentExportFlags organisationId={organisationId} contactId={template.contactId} lineTaxCodes={template.lines.map((line) => line.taxCode)}
          editable={template.status !== "ended"}
        />
        {template.resumedFrom ? <div className={ui.muted}>Dates before {formatDate(template.resumedFrom)} that weren&apos;t made are skipped.</div> : null}
        <CustomValuesText setup={customSetup.data} values={template.customFields} />
        <SalesLinesTable organisationId={organisationId} document={template} />
        <p className={ui.muted}>
          Saved by {personName(template, "createdBy") ?? "unknown"} on {formatDateTime(template.createdAt)}.
        </p>
      </Card>
      {can("bookkeeper") ? (
        <RepeatingActions
          key={template.status}
          organisationId={organisationId}
          template={template}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      <Card title="Invoices made" description="One per scheduled date, newest first. A date is never made twice.">
        {template.runs.length === 0 ? (
          <Empty>No invoices made yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Invoice</th>
                  <th>Result</th>
                  <th>Made</th>
                </tr>
              </thead>
              <tbody>
                {template.runs.map((run) => (
                  <tr key={run.id}>
                    <td data-label="Date">{formatDate(run.scheduledDate)}</td>
                    <td data-label="Invoice">
                      {run.invoiceId ? (
                        <Link href={`/operations/invoices/${run.invoiceId}`}>{run.invoiceNumber ?? `Draft #${run.invoiceId}`}</Link>
                      ) : run.invoiceDeleted ? (
                        <span className={ui.muted}>Draft deleted</span>
                      ) : null}
                    </td>
                    <td data-label="Result">
                      {OUTCOMES[run.outcome]}
                      {run.message ? <div className={ui.muted}>{run.message}</div> : null}
                    </td>
                    <td data-label="Made">
                      {formatDateTime(run.createdAt)} by {personName(run, "createdBy") ?? "unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p>
        <Link href="/operations/repeating-invoices">Back to repeating invoices</Link>
      </p>
    </>
  );
}

export default function RepeatingInvoicePage() {
  const { repeatingInvoiceId } = useParams<{ repeatingInvoiceId: string }>();
  return (
    <Page>
      <PageHeader title="Repeating invoice" />
      <RequireOrganisation>{(organisationId) => <RepeatingView organisationId={organisationId} id={repeatingInvoiceId} />}</RequireOrganisation>
    </Page>
  );
}
