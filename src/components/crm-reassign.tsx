"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { ReassignOptions } from "@/lib/crm/reassign";
import { REASSIGN_KINDS, type ReassignKind, type ReassignmentEntry, type ReassignPreview, type ReassignResult, tickedIds } from "@/lib/crm/reassign-rules";
import { formatDateTime } from "@/lib/format";

const KIND_LABELS: Record<ReassignKind, { title: string; one: string; help: string }> = {
  leads: { title: "Leads", one: "lead", help: "Leads that haven't been converted." },
  companies: { title: "Companies", one: "company", help: "Companies they're the owner of. Everyone still sees every company." },
  opportunities: { title: "Deals", one: "deal", help: "Open deals. Tick below to move won and lost ones too." },
  tasks: { title: "Tasks", one: "task", help: "Tasks that aren't done. Done tasks stay with whoever did them." },
  sequences: { title: "Sequences", one: "sequence", help: "Sequences whose next steps make tasks for them." },
};

function recordHref(kind: ReassignKind, id: string): string | null {
  if (kind === "leads") return `/crm/leads/${id}`;
  if (kind === "companies") return `/crm/companies/${id}`;
  if (kind === "opportunities") return `/crm/opportunities/${id}`;
  if (kind === "tasks") return "/crm/tasks";
  return "/crm/sequences";
}

function movedSummary(moved: Record<ReassignKind, number>): string {
  const parts = REASSIGN_KINDS.filter((kind) => moved[kind] > 0).map((kind) => `${moved[kind]} ${moved[kind] === 1 ? KIND_LABELS[kind].one : KIND_LABELS[kind].title.toLowerCase()}`);
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

/**
 * CRM › Settings › Reassign records (decision 650), after Salesforce's Mass
 * Transfer Records: choose whose records and who gets them, look through
 * what will move (untick any to keep), then move them.
 */
export function ReassignPage({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ options: ReassignOptions; reassignments: Array<ReassignmentEntry & { byName?: string }> }>("/api/crm/reassign", { organisationId });
  const options = data.data?.options;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kinds, setKinds] = useState<ReassignKind[]>([...REASSIGN_KINDS]);
  const [includeClosedDeals, setIncludeClosedDeals] = useState(false);
  const [preview, setPreview] = useState<ReassignPreview | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ReassignResult | null>(null);
  const { busy, error, run } = useBusy();

  const names = useMemo(() => new Map((options?.people ?? []).map((person) => [person.userId, person.displayName])), [options]);
  const nameOf = (id: string | null) => (id === null ? "Nobody" : (names.get(id) ?? "Former member"));
  const body = { organisationId, fromUserId: from, toUserId: to, kinds, includeClosedDeals };
  const reset = () => {
    setPreview(null);
    setUnticked(new Set());
  };

  function look(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    void run(async () => {
      const response = await api<{ preview: ReassignPreview }>("/api/crm/reassign/preview", { method: "POST", body });
      setPreview(response.preview);
      setUnticked(new Set());
    });
  }

  function move() {
    if (!preview) return;
    void run(async () => {
      const response = await api<{ result: ReassignResult }>("/api/crm/reassign", { method: "POST", body: { ...body, ids: tickedIds(preview, unticked) } });
      setResult(response.result);
      reset();
      data.reload();
    });
  }

  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!options) return <p className={ui.muted}>Loading…</p>;
  if (!options.allowed) {
    return (
      <Notice>
        Moving records to someone else needs the bookkeeper role or higher, or the sales manager role. A sales rep can ask their sales manager.
      </Notice>
    );
  }

  const toggleKind = (kind: ReassignKind) => {
    reset();
    setKinds((now) => (now.includes(kind) ? now.filter((entry) => entry !== kind) : [...now, kind]));
  };
  const toggleItem = (key: string) =>
    setUnticked((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const ticked = preview ? tickedIds(preview, unticked) : null;
  const tickedCount = ticked ? REASSIGN_KINDS.reduce((sum, kind) => sum + ticked[kind].length, 0) : 0;

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone="success">
          Moved {movedSummary(result.moved)}.{result.skipped > 0 ? ` ${result.skipped} had changed since you looked, so they were left alone.` : ""}
        </Notice>
      ) : null}
      <Card
        title="Move records to someone else"
        description="For when someone leaves, goes on leave or changes patch. Each record moved gets a line in its history."
      >
        <form onSubmit={look} style={{ display: "grid", gap: 12 }}>
          <div className={ui.inlineForm}>
            <Field label="From">
              <select
                value={from}
                required
                onChange={(event) => {
                  reset();
                  setFrom(event.target.value);
                }}
              >
                <option value="">Choose…</option>
                <option value="none">Nobody (unassigned)</option>
                {options.people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.displayName}
                  </option>
                ))}
                {options.formerOwners.map((id, index) => (
                  <option key={id} value={id}>
                    Former member {options.formerOwners.length > 1 ? index + 1 : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select
                value={to}
                required
                onChange={(event) => {
                  reset();
                  setTo(event.target.value);
                }}
              >
                <option value="">Choose…</option>
                {options.people
                  .filter((person) => person.canReceive && person.userId !== from)
                  .map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.displayName}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
            <legend className={ui.muted}>What to move</legend>
            {REASSIGN_KINDS.map((kind) => (
              <label key={kind}>
                <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} /> {KIND_LABELS[kind].title}{" "}
                <span className={ui.muted}>· {KIND_LABELS[kind].help}</span>
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={includeClosedDeals}
                onChange={(event) => {
                  reset();
                  setIncludeClosedDeals(event.target.checked);
                }}
              />{" "}
              Won and lost deals too <span className={ui.muted}>· their wins then count for the new owner on forecasts and the dashboard</span>
            </label>
          </fieldset>
          {from === "none" ? <p className={ui.muted}>From nobody: unassigned leads, deals and tasks. Companies with no owner are left alone.</p> : null}
          <p className={ui.muted}>People have no owner (everyone sees them), so only their open tasks and sequences move.</p>
          <span>
            <Button type="submit" disabled={busy || !from || !to || kinds.length === 0}>
              See what will move
            </Button>
          </span>
        </form>
      </Card>

      {preview ? (
        <Card
          title={`${nameOf(preview.fromUserId)} to ${nameOf(preview.toUserId)}`}
          description="Untick anything that should stay where it is."
          actions={
            <Button size="small" disabled={busy || tickedCount === 0} onClick={move}>
              Move {tickedCount} {tickedCount === 1 ? "record" : "records"}
            </Button>
          }
        >
          {REASSIGN_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => {
            const items = preview.records[kind];
            return (
              <section key={kind} style={{ display: "grid", gap: 4, padding: "8px 0", borderTop: "1px solid var(--line, #e5e5e5)" }} aria-label={KIND_LABELS[kind].title}>
                <strong>
                  {KIND_LABELS[kind].title} ({items.length}
                  {preview.more.includes(kind) ? "+" : ""})
                </strong>
                {preview.more.includes(kind) ? <span className={ui.muted}>Only the first {items.length} are shown and moved; move again for the rest.</span> : null}
                {items.length === 0 ? <span className={ui.muted}>Nothing to move.</span> : null}
                {items.map((item) => {
                  const key = `${kind}:${item.id}`;
                  const href = recordHref(kind, item.id);
                  return (
                    <label key={key} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <input type="checkbox" checked={!unticked.has(key)} onChange={() => toggleItem(key)} aria-label={`Move ${item.name}`} />
                      {href ? <Link href={href}>{item.name}</Link> : item.name}
                      {item.detail ? <span className={ui.muted}>{item.detail}</span> : null}
                    </label>
                  );
                })}
              </section>
            );
          })}
        </Card>
      ) : null}

      <Card title="Recent moves" description="Who moved what, and when.">
        {data.data && data.data.reassignments.length === 0 ? <Empty>Nothing has been moved yet.</Empty> : null}
        {(data.data?.reassignments ?? []).map((entry) => (
          <div key={entry.batchId} style={{ padding: "6px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
            <strong>
              {nameOf(entry.fromUserId)} to {nameOf(entry.toUserId)}
            </strong>
            : {movedSummary(entry.moved)}
            <div className={ui.muted}>
              {formatDateTime(entry.at)}
              {entry.byUserId && names.has(entry.byUserId) ? ` · by ${names.get(entry.byUserId)}` : entry.byEmail ? ` · by ${entry.byName ?? entry.byEmail}` : ""}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}
