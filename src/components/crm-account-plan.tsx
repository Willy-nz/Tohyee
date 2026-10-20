"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, memberName, useBaseCurrency, useBusy, useTeam } from "@/components/crm";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import {
  BUYING_ROLE_LABELS,
  BUYING_ROLES,
  type BuyingRole,
  GOAL_STATUS_LABELS,
  GOAL_STATUSES,
  type GoalStatus,
  goalProgress,
  renewalWhen,
} from "@/lib/crm/account-plan-types";
import type { AccountPlan } from "@/lib/crm/account-plans";
import type { DealLine } from "@/lib/crm/deal-lines";
import type { Opportunity } from "@/lib/crm/service";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";

type GoalRow = { key: number; title: string; targetDate: string; status: GoalStatus };
type RoleRow = { personId: string; role: BuyingRole | ""; note: string };

let rowKey = 0;
const nextKey = () => (rowKey += 1);

function PlanEditor({ organisationId, plan, onDone }: { organisationId: string; plan: AccountPlan; onDone: (saved: boolean) => void }) {
  const [summary, setSummary] = useState(plan.summary ?? "");
  const [goals, setGoals] = useState<GoalRow[]>(plan.goals.map((goal) => ({ key: nextKey(), title: goal.title, targetDate: goal.targetDate ?? "", status: goal.status })));
  const [roles, setRoles] = useState<RoleRow[]>(plan.people.map((person) => ({ personId: person.personId, role: person.role ?? "", note: person.note ?? "" })));
  const { busy, error, run } = useBusy();
  const setGoal = (key: number, change: Partial<GoalRow>) => setGoals((now) => now.map((goal) => (goal.key === key ? { ...goal, ...change } : goal)));
  const setRole = (personId: string, change: Partial<RoleRow>) => setRoles((now) => now.map((row) => (row.personId === personId ? { ...row, ...change } : row)));
  const save = () =>
    void run(async () => {
      await api(`/api/crm/companies/${plan.contactId}/plan`, {
        method: "PUT",
        body: {
          organisationId,
          summary: summary.trim() || null,
          goals: goals.filter((goal) => goal.title.trim()).map((goal) => ({ title: goal.title.trim(), targetDate: goal.targetDate || null, status: goal.status })),
          people: roles.filter((row) => row.role).map((row) => ({ personId: row.personId, role: row.role, note: row.note.trim() || null })),
        },
      });
      onDone(true);
    });
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Where things stand" hint="What they buy, what matters to them, risks and chances to sell more.">
        <textarea value={summary} maxLength={4000} rows={4} onChange={(event) => setSummary(event.target.value)} />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
        <legend>
          <strong>Goals</strong>
        </legend>
        {goals.map((goal, index) => (
          <div key={goal.key} className={ui.inlineForm}>
            <Field label={`Goal ${index + 1}`}>
              <input value={goal.title} maxLength={200} onChange={(event) => setGoal(goal.key, { title: event.target.value })} />
            </Field>
            <Field label="By">
              <DateInput value={goal.targetDate} onChange={(event) => setGoal(goal.key, { targetDate: event.target.value })} />
            </Field>
            <Field label="Status">
              <select value={goal.status} onChange={(event) => setGoal(goal.key, { status: event.target.value as GoalStatus })}>
                {GOAL_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {GOAL_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </Field>
            <Button size="small" variant="secondary" onClick={() => setGoals((now) => now.filter((entry) => entry.key !== goal.key))} aria-label={`Remove goal ${index + 1}`}>
              Remove
            </Button>
          </div>
        ))}
        <span>
          <Button size="small" variant="secondary" disabled={goals.length >= 50} onClick={() => setGoals((now) => [...now, { key: nextKey(), title: "", targetDate: "", status: "open" }])}>
            Add goal
          </Button>
        </span>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
        <legend>
          <strong>Their people</strong> <span className={ui.muted}>· the part each plays in buying</span>
        </legend>
        {plan.people.length === 0 ? <p className={ui.muted}>No people at this company yet. Add them under People.</p> : null}
        {plan.people.map((person) => {
          const row = roles.find((entry) => entry.personId === person.personId)!;
          return (
            <div key={person.personId} className={ui.inlineForm}>
              <Field label={person.name}>
                <select value={row.role} onChange={(event) => setRole(person.personId, { role: event.target.value as BuyingRole | "" })}>
                  <option value="">No part set</option>
                  {BUYING_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {BUYING_ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Note">
                <input value={row.note} maxLength={300} disabled={!row.role} onChange={(event) => setRole(person.personId, { note: event.target.value })} />
              </Field>
            </div>
          );
        })}
      </fieldset>
      <span style={{ display: "flex", gap: 8 }}>
        <Button onClick={save} disabled={busy}>
          Save plan
        </Button>
        <Button variant="secondary" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/**
 * A company's account plan (decision 653): where things stand, goals, the
 * part each person plays, renewals coming up, open deals and next steps
 * (the company's open tasks).
 */
export function AccountPlanCard({ organisationId, contactId, onChanged }: { organisationId: string; contactId: string; onChanged?: () => void }) {
  const { canCrm } = useWorkspace();
  const data = useApiData<{ plan: AccountPlan }>(`/api/crm/companies/${contactId}/plan`, { organisationId });
  const team = useTeam(organisationId).data?.team;
  const baseCurrency = useBaseCurrency();
  const [editing, setEditing] = useState(false);
  const today = todayInBrowser();
  const plan = data.data?.plan;
  const roled = plan?.people.filter((person) => person.role) ?? [];
  return (
    <Card
      title="Account plan"
      description={plan ? goalProgress(plan.goals) : undefined}
      actions={
        plan && canCrm("write") && !editing ? (
          <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
            {plan.saved ? "Edit plan" : "Start a plan"}
          </Button>
        ) : null
      }
    >
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {!plan ? <p className={ui.muted}>Loading…</p> : null}
      {plan && editing ? (
        <PlanEditor
          organisationId={organisationId}
          plan={plan}
          onDone={(saved) => {
            setEditing(false);
            if (saved) {
              data.reload();
              onChanged?.();
            }
          }}
        />
      ) : null}
      {plan && !editing ? (
        <div style={{ display: "grid", gap: 12 }}>
          {plan.summary ? <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{plan.summary}</p> : null}
          {!plan.saved ? <Empty>No plan yet. A plan keeps goals, who&apos;s who and what&apos;s next for this company in one place.</Empty> : null}
          {plan.goals.length > 0 ? (
            <section aria-label="Goals">
              <strong>Goals</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {plan.goals.map((goal, index) => (
                  <li key={index}>
                    {goal.status === "achieved" ? <Badge tone="green">Achieved</Badge> : goal.status === "dropped" ? <Badge>Dropped</Badge> : null} {goal.title}
                    {goal.targetDate ? <span className={ui.muted}> · by {formatDate(goal.targetDate)}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {roled.length > 0 ? (
            <section aria-label="Their people">
              <strong>Their people</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {roled.map((person) => (
                  <li key={person.personId}>
                    <Link href={`/crm/people/${person.personId}`}>{person.name}</Link>
                    {person.jobTitle ? <span className={ui.muted}>, {person.jobTitle}</span> : null}: {BUYING_ROLE_LABELS[person.role!]}
                    {person.note ? <span className={ui.muted}> · {person.note}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-label="Renewals">
            <strong>Renewals</strong>
            {plan.renewals.length === 0 ? (
              <p className={ui.muted} style={{ margin: "4px 0 0" }}>
                None in the next year. Set renewal dates on a deal.
              </p>
            ) : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {plan.renewals.map((renewal) => (
                  <li key={`${renewal.opportunityId}:${renewal.renewalDate}`}>
                    {formatDate(renewal.renewalDate)} <span className={ui.muted}>({renewalWhen(renewal.renewalDate, today)})</span>:{" "}
                    <Link href={`/crm/opportunities/${renewal.opportunityId}`}>{renewal.opportunityName}</Link>
                    {renewal.what.length > 0 ? <span className={ui.muted}> · {renewal.what.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Open deals">
            <strong>Open deals</strong>
            {plan.openDeals.length === 0 ? (
              <p className={ui.muted} style={{ margin: "4px 0 0" }}>
                None open.
              </p>
            ) : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {plan.openDeals.map((deal) => (
                  <li key={deal.id}>
                    <Link href={`/crm/opportunities/${deal.id}`}>{deal.name}</Link>{" "}
                    <span className={ui.muted}>
                      · {deal.stageName} · {amountIn(deal.amount, deal.currencyCode, baseCurrency)}
                      {deal.ownerUserId ? ` · ${memberName(team, deal.ownerUserId)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Next steps">
            <strong>Next steps</strong>
            {plan.nextSteps.length === 0 ? (
              <p className={ui.muted} style={{ margin: "4px 0 0" }}>
                No open tasks. Add one under Tasks.
              </p>
            ) : (
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {plan.nextSteps.map((task) => (
                  <li key={task.id}>
                    {task.title}
                    <span className={ui.muted}>
                      {task.dueDate ? ` · due ${formatDate(task.dueDate)}` : ""}
                      {task.assigneeUserId ? ` · ${memberName(team, task.assigneeUserId)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {plan.updatedAt ? (
            <p className={ui.muted} style={{ margin: 0 }}>
              Plan last changed {formatDateTime(plan.updatedAt)}
              {plan.updatedByEmail ? ` by ${memberNameByEmail(team, plan.updatedByEmail)}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function memberNameByEmail(team: Array<{ email: string; displayName: string }> | undefined, email: string): string {
  return team?.find((member) => member.email.toLowerCase() === email.toLowerCase())?.displayName ?? email;
}

/** A deal's renewal dates (decision 654): the deal's own and each product's. A follow-up rule can remind the owner before them. */
export function DealRenewals({ organisationId, opportunity, onChanged }: { organisationId: string; opportunity: Opportunity; onChanged: () => void }) {
  const { canCrm } = useWorkspace();
  const lines = useApiData<{ lines: DealLine[] }>(`/api/crm/opportunities/${opportunity.id}/lines`, { organisationId });
  const [editing, setEditing] = useState<{ deal: string; lines: Record<number, string> } | null>(null);
  const { busy, error, run } = useBusy();
  const today = todayInBrowser();
  const products = lines.data?.lines ?? [];
  const lost = opportunity.stageType === "lost";
  const save = () =>
    void run(async () => {
      if (!editing) return;
      await api(`/api/crm/opportunities/${opportunity.id}/renewals`, {
        method: "PUT",
        body: {
          organisationId,
          renewalDate: editing.deal || null,
          lines: products.map((line) => ({ lineOrder: line.lineOrder, renewalDate: editing.lines[line.lineOrder] || null })),
        },
      });
      setEditing(null);
      lines.reload();
      onChanged();
    });
  const dated = products.filter((line) => line.renewalDate);
  return (
    <Card
      title="Renewals"
      description="When the deal or its products come up for renewal. A follow-up rule can remind the owner beforehand."
      actions={
        canCrm("write") && !lost && !editing ? (
          <Button
            size="small"
            variant="secondary"
            onClick={() => setEditing({ deal: opportunity.renewalDate ?? "", lines: Object.fromEntries(products.map((line) => [line.lineOrder, line.renewalDate ?? ""])) })}
          >
            Set dates
          </Button>
        ) : null
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing ? (
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="The deal renews on">
            <DateInput value={editing.deal} onChange={(event) => setEditing({ ...editing, deal: event.target.value })} />
          </Field>
          {products.map((line) => (
            <Field key={line.lineOrder} label={`${line.description} renews on`}>
              <DateInput value={editing.lines[line.lineOrder] ?? ""} onChange={(event) => setEditing({ ...editing, lines: { ...editing.lines, [line.lineOrder]: event.target.value } })} />
            </Field>
          ))}
          <span style={{ display: "flex", gap: 8 }}>
            <Button size="small" onClick={save} disabled={busy}>
              Save dates
            </Button>
            <Button size="small" variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
          </span>
        </div>
      ) : opportunity.renewalDate || dated.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {opportunity.renewalDate ? (
            <li>
              The deal: {formatDate(opportunity.renewalDate)} <span className={ui.muted}>({renewalWhen(opportunity.renewalDate, today)})</span>
            </li>
          ) : null}
          {dated.map((line) => (
            <li key={line.lineOrder}>
              {line.description}: {formatDate(line.renewalDate!)} <span className={ui.muted}>({renewalWhen(line.renewalDate!, today)})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted} style={{ margin: 0 }}>
          {lost ? "A lost deal doesn't renew." : "No renewal dates."}
        </p>
      )}
    </Card>
  );
}
