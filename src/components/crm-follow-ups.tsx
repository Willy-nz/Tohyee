"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useBusy, useStages } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { FollowUpKind, FollowUpRule, FollowUpRun } from "@/lib/crm/follow-ups";
import { formatDateTime } from "@/lib/format";

const KINDS: Record<FollowUpKind, { label: string; days: string; help: string; minDays: number }> = {
  lead_arrives: {
    label: "A new lead arrives",
    days: "Due in (days)",
    help: "A task for the lead's owner. A lead nobody owns gets one for each sales team manager.",
    minDays: 0,
  },
  deal_stage: {
    label: "A deal reaches a stage",
    days: "Due after (days)",
    help: "A follow-up task for the deal's owner, due this many days after the deal got to the stage.",
    minDays: 0,
  },
  deal_quiet: {
    label: "A deal goes quiet",
    days: "Quiet for (days)",
    help: "A reminder for the owner of an open deal with no call, meeting, note, finished task or change for this many days. Once per quiet spell.",
    minDays: 1,
  },
  task_overdue: {
    label: "A task is overdue",
    days: "Overdue by (days)",
    help: "A task for the assignee's sales team manager. People who aren't in a team are left alone.",
    minDays: 1,
  },
};

type RuleForm = { kind: FollowUpKind; name: string; stageKey: string; days: string; taskTitle: string };

function RuleEditor({ organisationId, rule, onDone }: { organisationId: string; rule: FollowUpRule | null; onDone: () => void }) {
  const stages = useStages(organisationId).data?.stages.filter((stage) => stage.type === "open" && stage.isActive) ?? [];
  const [form, setForm] = useState<RuleForm>({
    kind: rule?.kind ?? "lead_arrives",
    name: rule?.name ?? "",
    stageKey: rule?.stageKey ?? "",
    days: String(rule?.days ?? 1),
    taskTitle: rule?.taskTitle ?? "",
  });
  const { busy, error, run } = useBusy();
  const kind = KINDS[form.kind];
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const body = {
        organisationId,
        name: form.name,
        days: Number(form.days),
        taskTitle: form.taskTitle || null,
        ...(form.kind === "deal_stage" ? { stageKey: form.stageKey } : {}),
      };
      if (rule) await api(`/api/crm/follow-up-rules/${rule.id}`, { method: "PATCH", body });
      else await api("/api/crm/follow-up-rules", { method: "POST", body: { ...body, kind: form.kind } });
      onDone();
    });
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="When">
          <select value={form.kind} disabled={rule !== null} onChange={(event) => setForm({ ...form, kind: event.target.value as FollowUpKind })}>
            {(Object.keys(KINDS) as FollowUpKind[]).map((key) => (
              <option key={key} value={key}>
                {KINDS[key].label}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === "deal_stage" ? (
          <Field label="Stage">
            <select value={form.stageKey} required onChange={(event) => setForm({ ...form, stageKey: event.target.value })}>
              <option value="">Choose…</option>
              {stages.map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={kind.days}>
          <input type="number" min={kind.minDays} max={365} step={1} required value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value })} />
        </Field>
      </div>
      <p className={ui.muted}>{kind.help}</p>
      <div className={ui.inlineForm}>
        <Field label="Rule name">
          <input value={form.name} maxLength={100} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Task title (optional)" hint="The lead's, deal's or task's name is added after it.">
          <input value={form.taskTitle} maxLength={150} onChange={(event) => setForm({ ...form, taskTitle: event.target.value })} />
        </Field>
      </div>
      <span className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          {rule ? "Save rule" : "Add rule"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function describe(rule: FollowUpRule, stageName: (key: string | null) => string): string {
  switch (rule.kind) {
    case "lead_arrives":
      return `When a lead arrives: a task due ${rule.days === 0 ? "the same day" : `in ${rule.days} day${rule.days === 1 ? "" : "s"}`}.`;
    case "deal_stage":
      return `When a deal reaches ${stageName(rule.stageKey)}: a task due ${rule.days === 0 ? "the same day" : `${rule.days} day${rule.days === 1 ? "" : "s"} later`}.`;
    case "deal_quiet":
      return `When an open deal has been quiet for ${rule.days} day${rule.days === 1 ? "" : "s"}: a reminder for its owner.`;
    case "task_overdue":
      return `When a task is ${rule.days} day${rule.days === 1 ? "" : "s"} overdue: a task for the team's manager.`;
  }
}

/**
 * CRM › Follow-ups (decision 495): rules that make tasks when a lead arrives,
 * a deal reaches a stage or goes quiet, or a task is overdue, and what each
 * run did. Checked every 15 minutes, or now.
 */
export function FollowUpsPage({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ rules: FollowUpRule[]; runs: FollowUpRun[] }>("/api/crm/follow-up-rules", { organisationId });
  const stages = useStages(organisationId).data?.stages ?? [];
  const stageName = (key: string | null) => stages.find((stage) => stage.key === key)?.name ?? key ?? "";
  const [editing, setEditing] = useState<FollowUpRule | "new" | null>(null);
  const [ran, setRan] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const done = () => {
    setEditing(null);
    data.reload();
  };
  const rules = data.data?.rules ?? [];
  const runs = data.data?.runs ?? [];
  return (
    <>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {ran ? <Notice tone="success">{ran}</Notice> : null}
      <Card
        title="Follow-up rules"
        description="Each rule makes a task for the right person. Rules are checked every 15 minutes; a lead or a stage change only counts from when its rule was added. Reminders stay in Tohyee: nothing is emailed."
        actions={
          editing === null ? (
            <span className={ui.rowButtons}>
              <Button
                size="small"
                variant="secondary"
                disabled={busy || rules.every((rule) => !rule.isActive)}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ tasksCreated: number; skipped: number }>("/api/crm/follow-up-rules/run", { method: "POST", body: { organisationId } });
                    setRan(
                      result.tasksCreated === 0
                        ? "Checked: no new follow-ups."
                        : `Checked: ${result.tasksCreated} task${result.tasksCreated === 1 ? "" : "s"} made.${result.skipped ? ` ${result.skipped} skipped.` : ""}`,
                    );
                    data.reload();
                  })
                }
              >
                Run now
              </Button>
              <Button size="small" onClick={() => setEditing("new")}>
                Add rule
              </Button>
            </span>
          ) : null
        }
      >
        {editing === "new" ? <RuleEditor organisationId={organisationId} rule={null} onDone={done} /> : null}
        {data.data && rules.length === 0 && editing !== "new" ? <Empty>No rules yet.</Empty> : null}
        {rules.map((rule) =>
          editing !== "new" && editing?.id === rule.id ? (
            <RuleEditor key={rule.id} organisationId={organisationId} rule={rule} onDone={done} />
          ) : (
            <div key={rule.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
              <div>
                <strong>{rule.name}</strong> {rule.isActive ? null : <Badge>Off</Badge>}
                <div className={ui.muted}>{describe(rule, stageName)}</div>
              </div>
              <span className={ui.rowButtons}>
                <Button size="small" variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing(rule)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy || editing !== null}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/crm/follow-up-rules/${rule.id}`, { method: "PATCH", body: { organisationId, isActive: !rule.isActive } });
                      data.reload();
                    })
                  }
                >
                  {rule.isActive ? "Switch off" : "Switch on"}
                </Button>
              </span>
            </div>
          ),
        )}
      </Card>
      <Card title="What the rules did" description="The latest 100 runs, newest first.">
        {data.data && runs.length === 0 ? <Empty>Nothing yet.</Empty> : null}
        {runs.length > 0 ? (
          <table className={ui.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.ranAt)}</td>
                  <td>{entry.ruleName}</td>
                  <td>
                    {entry.outcome === "skipped" ? (
                      <span className={ui.muted}>Skipped: {entry.detail}</span>
                    ) : entry.taskId ? (
                      <>
                        Task: <Link href={entry.leadId ? `/crm/leads/${entry.leadId}` : entry.opportunityId ? `/crm/opportunities/${entry.opportunityId}` : "/crm/tasks"}>{entry.taskTitle}</Link>
                      </>
                    ) : (
                      "Task made"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}
