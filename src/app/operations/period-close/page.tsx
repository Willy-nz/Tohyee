"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { monthLabel } from "@/lib/financial-year";
import { formatDate, formatDateTime } from "@/lib/format";
import type { CheckStatus, PeriodChecklist, PeriodList, PeriodMonth, PeriodStatus } from "@/lib/ledger/period-close";

function StatusBadge({ status }: { status: PeriodStatus | "open" | "closed" }) {
  if (status === "closed") return <Badge tone="green">Closed</Badge>;
  if (status === "partly_locked") return <Badge tone="blue">Partly locked</Badge>;
  return <Badge>Open</Badge>;
}

function CheckBadge({ status }: { status: CheckStatus }) {
  if (status === "pass") return <Badge tone="green">Pass</Badge>;
  if (status === "warning") return <Badge tone="amber">Needs attention</Badge>;
  return <Badge>Not applicable</Badge>;
}

const EVENT_LABELS: Record<string, string> = {
  "ledger.period_closed": "Closed",
  "ledger.period_reopened": "Reopened",
  "ledger.period_locked": "Locked",
  "ledger.period_controls_updated": "Lock changed",
};

function Checklist({
  organisationId,
  month,
  onChanged,
}: {
  organisationId: string;
  month: PeriodMonth;
  onChanged: (message: string) => void;
}) {
  const { can } = useWorkspace();
  const checklist = useApiData<{ checklist: PeriodChecklist }>("/api/ledger/period-close/checks", { organisationId, periodEnd: month.end });
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = checklist.data?.checklist;

  async function send(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/ledger/period-close", { method: "POST", body: { organisationId, periodEnd: month.end, ...body } });
      onChanged(message);
    } catch (caught) {
      setError(errorMessage(caught));
      checklist.reload();
    } finally {
      setBusy(false);
    }
  }

  function reopen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send({ action: "reopen", reason }, `${month.label} reopened, with every later month.`);
  }

  return (
    <Card
      title={`Checklist for ${month.label}`}
      description={
        data
          ? `${data.from ? `Covers ${formatDate(data.from)} to ${formatDate(data.periodEnd)}` : `Covers everything up to ${formatDate(data.periodEnd)}`}. Worked out from the books each time it's opened; it posts nothing.`
          : undefined
      }
      actions={<Button variant="secondary" size="small" onClick={() => checklist.reload()}>Check again</Button>}
    >
      {checklist.error ? <Notice tone="error">{checklist.error}</Notice> : null}
      {checklist.loading && !data ? <p className={ui.muted}>Checking…</p> : null}
      {data ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.checks.map((check) => (
                  <tr key={check.key} data-check={check.key}>
                    <td>
                      <strong>{check.title}</strong>
                    </td>
                    <td>
                      <CheckBadge status={check.status} />
                    </td>
                    <td>
                      <div>{check.summary}</div>
                      {check.items.length > 0 ? (
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          {check.items.map((item, index) => (
                            <li key={index}>
                              {item.href ? <Link href={item.href}>{item.label}</Link> : <strong>{item.label}</strong>}: {item.detail}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {check.fix && check.status === "warning" ? (
                        <div>
                          <Link href={check.fix.href}>{check.fix.label} →</Link>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {month.status === "closed" ? (
            can("admin") ? (
              <form onSubmit={reopen} style={{ display: "grid", gap: 8 }}>
                <Notice tone="info">
                  {month.label} is closed. Reopening it also reopens every later closed month, as in NetSuite. The reason goes in the audit log.
                </Notice>
                <Field label="Why reopen it?">
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} required />
                </Field>
                <div>
                  <Button type="submit" variant="danger" disabled={busy || reason.trim() === ""}>
                    {busy ? "Reopening…" : `Reopen ${month.label}`}
                  </Button>
                </div>
              </form>
            ) : (
              <Notice tone="info">{month.label} is closed. An owner or admin can reopen it.</Notice>
            )
          ) : !month.canClose ? (
            <Notice tone="info">Earlier months with postings are still open: months are closed in order.</Notice>
          ) : data.warnings === 0 ? (
            can("bookkeeper") ? (
              <div>
                <Button disabled={busy} onClick={() => void send({ action: "close" }, `${month.label} closed.`)}>
                  {busy ? "Closing…" : `Close ${month.label}`}
                </Button>
              </div>
            ) : null
          ) : can("admin") ? (
            <div style={{ display: "grid", gap: 8 }}>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                {data.warnings === 1 ? "One check needs" : `${data.warnings} checks need`} attention. I&apos;ve reviewed{" "}
                {data.warnings === 1 ? "it" : "them"} and want to close {month.label} anyway (recorded in the audit log).
              </label>
              <div>
                <Button
                  variant="danger"
                  disabled={busy || !acknowledged}
                  onClick={() => void send({ action: "close", acknowledgeWarnings: true }, `${month.label} closed with ${data.warnings} ${data.warnings === 1 ? "warning" : "warnings"} accepted.`)}
                >
                  {busy ? "Closing…" : `Close ${month.label} anyway`}
                </Button>
              </div>
            </div>
          ) : (
            <Notice tone="warning">
              Fix the checks that need attention to close {month.label}, or ask an owner or admin to close it anyway.
            </Notice>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function PeriodClose({ organisationId }: { organisationId: string }) {
  const periods = useApiData<{ periods: PeriodList }>("/api/ledger/period-close", { organisationId });
  const [chosen, setChosen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = periods.data?.periods;
  const months = data?.years.flatMap((year) => year.months) ?? [];
  const selectedEnd = chosen ?? data?.nextToClose ?? months[0]?.end ?? null;
  const selected = months.find((month) => month.end === selectedEnd) ?? null;

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {periods.error ? <Notice tone="error">{periods.error}</Notice> : null}
      <Card
        title="Periods"
        description={
          data
            ? data.lockDate
              ? `Closed up to ${formatDate(data.lockDate)}: nothing dated on or before it can be posted or changed.`
              : "Nothing is closed yet."
            : undefined
        }
      >
        {periods.loading && !data ? <p className={ui.muted}>Loading…</p> : null}
        {data && months.length === 0 ? <Empty>No periods yet.</Empty> : null}
        {data ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Postings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.years.flatMap((year) => [
                  <tr key={year.end} className={ui.reportHeading}>
                    <td>Year ending {formatDate(year.end)}</td>
                    <td>
                      <StatusBadge status={year.status} />
                    </td>
                    <td colSpan={2} />
                  </tr>,
                  ...year.months.map((month) => (
                    <tr key={month.end} className={month.end === selectedEnd ? ui.selectedRow : undefined}>
                      <td>{month.label}</td>
                      <td>
                        <StatusBadge status={month.status} />
                      </td>
                      <td>{month.hasPostings ? "Yes" : <span className={ui.muted}>None</span>}</td>
                      <td className={ui.num}>
                        <Button
                          size="small"
                          variant={month.end === selectedEnd ? "primary" : "secondary"}
                          onClick={() => {
                            setChosen(month.end);
                            setMessage(null);
                          }}
                        >
                          {month.status === "closed" ? "View" : month.canClose ? "Checklist" : "View"}
                        </Button>
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {selected ? (
        <Checklist
          key={`${selected.end}-${selected.status}-${data?.lockDate ?? ""}`}
          organisationId={organisationId}
          month={selected}
          onChanged={(text) => {
            setMessage(text);
            periods.reload();
          }}
        />
      ) : null}
      {data && data.history.length > 0 ? (
        <Card title="History" description="Every close and reopen, from the audit log.">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Who</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt)}</td>
                    <td>
                      {EVENT_LABELS[entry.eventType] ?? entry.eventType}
                      {entry.periodEnd ? ` ${monthLabel(entry.periodEnd)}` : ""}
                    </td>
                    <td>{entry.actorEmail ?? "Tohyee"}</td>
                    <td>
                      {`Lock ${entry.from ? formatDate(entry.from) : "none"} → ${entry.to ? formatDate(entry.to) : "none"}`}
                      {entry.reason ? <div>Reason: {entry.reason}</div> : null}
                      {entry.warningsAccepted.length > 0 ? <div>Warnings accepted: {entry.warningsAccepted.join("; ")}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

export default function PeriodClosePage() {
  return (
    <Page>
      <PageHeader
        title="Period close"
        description="Close each month once its checks pass, like NetSuite's period close checklist. There are no closing journals: a year's profit moves into retained earnings on the balance sheet on the first day of the next year."
      />
      <RequireOrganisation>{(organisationId) => <PeriodClose key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
