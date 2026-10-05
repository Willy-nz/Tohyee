"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { RequireOrganisation } from "@/components/books";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { SalesLinesTable } from "@/components/documents/lines-table";
import { useApiData } from "@/components/hooks";
import { RepeatingStatusBadge } from "@/components/repeating/repeating-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import { describeBillDue } from "@/lib/repeating/bill-rules";
import type { RepeatingBill } from "@/lib/repeating/bills";
import type { RunOutcome, RunResult } from "@/lib/repeating/runner";
import { describeSchedule } from "@/lib/repeating/schedule";
import { useConfirm } from "@/components/confirm-dialog";

const OUTCOMES: Record<RunOutcome, string> = {
  draft: "Saved as a draft",
  approved: "Approved",
  approval_refused: "Left as a draft",
  submitted: "Submitted for approval",
};

/** Run now, pause, resume and end (RB2, RB8). */
function RepeatingBillActions({
  organisationId,
  template,
  onChanged,
}: {
  organisationId: string;
  template: RepeatingBill;
  onChanged: (template: RepeatingBill, message: string) => void;
}) {
  const confirm = useConfirm();
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
      const result = await api<{ result: RunResult; repeatingBill: RepeatingBill }>(`/api/repeating-bills/${template.id}/run`, {
        method: "POST",
        body: { organisationId },
      });
      const { made, approved, refused, failed } = result.result;
      const parts = [
        made === 0 ? "No bills were due." : `Made ${made} bill${made === 1 ? "" : "s"}.`,
        approved ? `${approved} approved.` : "",
        refused ? `${refused} left as draft (see the history).` : "",
        failed ? "One date couldn't be made; see the message above." : "",
      ];
      onChanged(result.repeatingBill, parts.filter(Boolean).join(" "));
    });
  }

  async function setStatus(status: "active" | "paused" | "ended", confirmText: string | null, done: string) {
    if (confirmText && !(await confirm(confirmText))) return;
    void run(async () => {
      const result = await api<{ repeatingBill: RepeatingBill }>(`/api/repeating-bills/${template.id}/status`, {
        method: "POST",
        body: { organisationId, status },
      });
      onChanged(result.repeatingBill, done);
    });
  }

  if (template.status === "ended") return null;
  return (
    <Card
      title="Actions"
      description="Run now makes any bills due up to today, the same as the hourly job. Pausing stops new bills; resuming carries on from today (dates while it was paused aren't made). Ending is final."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        {template.status === "active" ? (
          <>
            <Button onClick={runNow} disabled={busy}>
              {busy ? "Working…" : "Run now"}
            </Button>
            <Button variant="secondary" onClick={() => setStatus("paused", null, "Paused. No bills are made until it's resumed.")} disabled={busy}>
              Pause
            </Button>
          </>
        ) : (
          <Button onClick={() => setStatus("active", "Resume from today? Dates that fell while it was paused won't be made.", "Resumed from today.")} disabled={busy}>
            Resume
          </Button>
        )}
        <Button variant="secondary" onClick={() => router.push(`/operations/repeating-bills/${template.id}/edit`)} disabled={busy}>
          Change
        </Button>
        <Button
          variant="danger"
          onClick={() => setStatus("ended", "End this repeating bill? No more bills will be made, and it can't be started again.", "Ended.")}
          disabled={busy}
        >
          End
        </Button>
      </div>
    </Card>
  );
}

function RepeatingBillView({ organisationId, id }: { organisationId: string; id: string }) {
  const { can } = useWorkspace();
  const customSetup = useCustomFields(organisationId);
  const details = useApiData<{ repeatingBill: RepeatingBill }>(`/api/repeating-bills/${encodeURIComponent(id)}`, { organisationId });
  const [updated, setUpdated] = useState<RepeatingBill | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/repeating-bills">Back to repeating bills</Link>
        </p>
      </>
    );
  }
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const template = updated ?? details.data.repeatingBill;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {template.lastError ? <Notice tone="warning">The last run stopped at {template.lastError} It will try that date again next run.</Notice> : null}
      <Card
        title={`Repeating bill from ${template.contactName}`}
        description={`${describeSchedule(template)} · ${AMOUNTS_MODE_LABELS[template.amountsMode]} · ${template.currencyCode}`}
        actions={<RepeatingStatusBadge status={template.status} />}
      >
        <div className={ui.grid3}>
          <Stat label="First bill date" value={formatDate(template.startDate)} />
          <Stat label="End date" value={template.endDate ? formatDate(template.endDate) : "None"} />
          <Stat label="Next bill" value={template.nextDate ? formatDate(template.nextDate) : "—"} />
          <Stat label="Due" value={describeBillDue(template.dueRule, template.dueDays)} />
          <Stat label="Each bill is" value={template.saveAs === "approve" ? "Approved (nothing is paid)" : "Saved as a draft"} />
          <Stat label="Supplier's invoice number" value={template.supplierInvoiceNumber ?? "None: drafts without a number"} />
          <Stat label="Next bill's number" value={template.nextSupplierInvoiceNumber ?? "—"} />
        </div>
        {template.resumedFrom ? <div className={ui.muted}>Dates before {formatDate(template.resumedFrom)} that weren&apos;t made are skipped.</div> : null}
        <CustomValuesText setup={customSetup.data} values={template.customFields} />
        <SalesLinesTable organisationId={organisationId} document={template} />
        <p className={ui.muted}>
          Saved by {personName(template, "createdBy") ?? "unknown"} on {formatDateTime(template.createdAt)}.
        </p>
      </Card>
      {can("bookkeeper") ? (
        <RepeatingBillActions
          key={template.status}
          organisationId={organisationId}
          template={template}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      <Card title="Bills made" description="One per scheduled date, newest first. A date is never made twice.">
        {template.runs.length === 0 ? (
          <Empty>No bills made yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Bill</th>
                  <th>Result</th>
                  <th>Made</th>
                </tr>
              </thead>
              <tbody>
                {template.runs.map((run) => (
                  <tr key={run.id}>
                    <td data-label="Date">{formatDate(run.scheduledDate)}</td>
                    <td data-label="Bill">
                      {run.billId ? (
                        <>
                          <Link href={`/operations/bills/${run.billId}`}>{run.supplierInvoiceNumber ?? `Bill #${run.billId}`}</Link>{" "}
                          {run.billStatus ? <BillStatusBadge status={run.billStatus} /> : null}
                        </>
                      ) : run.billDeleted ? (
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
        <Link href="/operations/repeating-bills">Back to repeating bills</Link>
      </p>
    </>
  );
}

export default function RepeatingBillPage() {
  const { repeatingBillId } = useParams<{ repeatingBillId: string }>();
  return (
    <Page>
      <PageHeader title="Repeating bill" />
      <RequireOrganisation>{(organisationId) => <RepeatingBillView organisationId={organisationId} id={repeatingBillId} />}</RequireOrganisation>
    </Page>
  );
}
