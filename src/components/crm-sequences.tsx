"use client";

import { type FormEvent, useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { EmailTemplate } from "@/lib/crm/sales-email";
import type { Enrolment, Sequence, StepKind } from "@/lib/crm/sequences";
import { formatDate } from "@/lib/format";

const KIND_LABELS: Record<StepKind, string> = { email: "Email", call: "Call", task: "Task" };

type StepForm = { dayOffset: string; kind: StepKind; title: string; templateId: string };
type SequenceForm = { name: string; description: string; steps: StepForm[] };

const blankStep = (day = 0): StepForm => ({ dayOffset: String(day), kind: "call", title: "", templateId: "" });

function SequenceEditor({ organisationId, sequence, onDone }: { organisationId: string; sequence: Sequence | null; onDone: () => void }) {
  const templates = useApiData<{ templates: EmailTemplate[] }>("/api/crm/email-templates", { organisationId }).data?.templates.filter((t) => t.isActive) ?? [];
  const [form, setForm] = useState<SequenceForm>({
    name: sequence?.name ?? "",
    description: sequence?.description ?? "",
    steps: sequence?.steps.map((step) => ({ dayOffset: String(step.dayOffset), kind: step.kind, title: step.title, templateId: step.templateId ?? "" })) ?? [blankStep()],
  });
  const { busy, error, run } = useBusy();
  const locked = (sequence?.activeEnrolments ?? 0) > 0;
  const setStep = (index: number, change: Partial<StepForm>) => setForm({ ...form, steps: form.steps.map((step, at) => (at === index ? { ...step, ...change } : step)) });
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const body = {
        organisationId,
        name: form.name,
        description: form.description || null,
        ...(locked
          ? {}
          : {
              steps: form.steps.map((step) => ({
                dayOffset: Number(step.dayOffset),
                kind: step.kind,
                title: step.title,
                templateId: step.kind === "email" ? step.templateId || null : null,
              })),
            }),
      };
      if (sequence) await api(`/api/crm/sequences/${sequence.id}`, { method: "PATCH", body });
      else await api("/api/crm/sequences", { method: "POST", body });
      onDone();
    });
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={form.name} maxLength={100} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Description (optional)">
          <input value={form.description} maxLength={500} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
      </div>
      {locked ? <Notice tone="warning">Someone is part-way through this sequence, so its steps can&apos;t change. Make a new sequence for different steps.</Notice> : null}
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Day</th>
            <th>Step</th>
            <th>Task title</th>
            <th>Template</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {form.steps.map((step, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={`Step ${index + 1} day`}
                  type="number"
                  min={0}
                  max={365}
                  required
                  disabled={locked}
                  value={step.dayOffset}
                  style={{ width: 70 }}
                  onChange={(event) => setStep(index, { dayOffset: event.target.value })}
                />
              </td>
              <td>
                <select aria-label={`Step ${index + 1} kind`} disabled={locked} value={step.kind} onChange={(event) => setStep(index, { kind: event.target.value as StepKind })}>
                  {(Object.keys(KIND_LABELS) as StepKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label={`Step ${index + 1} title`} required maxLength={150} disabled={locked} value={step.title} onChange={(event) => setStep(index, { title: event.target.value })} />
              </td>
              <td>
                {step.kind === "email" ? (
                  <select aria-label={`Step ${index + 1} template`} required disabled={locked} value={step.templateId} onChange={(event) => setStep(index, { templateId: event.target.value })}>
                    <option value="">Choose…</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </td>
              <td>
                {!locked && form.steps.length > 1 ? (
                  <Button size="small" variant="secondary" type="button" onClick={() => setForm({ ...form, steps: form.steps.filter((_, at) => at !== index) })}>
                    Remove
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!locked && form.steps.length < 30 ? (
        <span>
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={() => setForm({ ...form, steps: [...form.steps, blankStep(Number(form.steps.at(-1)?.dayOffset ?? 0) + 2)] })}
          >
            Add step
          </Button>
        </span>
      ) : null}
      <span className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          {sequence ? "Save sequence" : "Add sequence"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function stepsText(sequence: Sequence): string {
  return sequence.steps.map((step) => `day ${step.dayOffset}: ${KIND_LABELS[step.kind].toLowerCase()}${step.templateName ? ` (${step.templateName})` : ""}`).join(" · ");
}

/**
 * CRM › Sequences (decision 497): steps on days from the start; each becomes
 * a task on its day, and nothing is ever sent by itself.
 */
export function SequencesPage({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ sequences: Sequence[] }>("/api/crm/sequences", { organisationId });
  const [editing, setEditing] = useState<Sequence | "new" | null>(null);
  const { busy, error, run } = useBusy();
  const done = () => {
    setEditing(null);
    data.reload();
  };
  const sequences = data.data?.sequences ?? [];
  return (
    <>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title="Sequences"
        description="Steps on set days after someone's added: on each step's day it becomes a task for the lead's or deal's owner (or whoever added a person). Email steps are a task to send that template; nothing is sent by itself. It stops when they reply, a lead is unqualified or converted, or a deal is won or lost."
        actions={
          editing === null ? (
            <Button size="small" onClick={() => setEditing("new")}>
              Add sequence
            </Button>
          ) : null
        }
      >
        {editing === "new" ? <SequenceEditor organisationId={organisationId} sequence={null} onDone={done} /> : null}
        {data.data && sequences.length === 0 && editing !== "new" ? <Empty>No sequences yet.</Empty> : null}
        {sequences.map((sequence) =>
          editing !== "new" && editing?.id === sequence.id ? (
            <SequenceEditor key={sequence.id} organisationId={organisationId} sequence={sequence} onDone={done} />
          ) : (
            <div key={sequence.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
              <div>
                <strong>{sequence.name}</strong> {sequence.isActive ? null : <Badge>Off</Badge>}{" "}
                {sequence.activeEnrolments > 0 ? <Badge tone="blue">{sequence.activeEnrolments} in it</Badge> : null}
                <div className={ui.muted}>{sequence.description ? `${sequence.description} · ` : ""}{stepsText(sequence)}</div>
              </div>
              <span className={ui.rowButtons}>
                <Button size="small" variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing(sequence)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy || editing !== null}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/crm/sequences/${sequence.id}`, { method: "PATCH", body: { organisationId, isActive: !sequence.isActive } });
                      data.reload();
                    })
                  }
                >
                  {sequence.isActive ? "Switch off" : "Switch on"}
                </Button>
              </span>
            </div>
          ),
        )}
      </Card>
    </>
  );
}

type Target = { leadId: string } | { personId: string } | { opportunityId: string };

const STATUS_TONES = { active: "blue", finished: "green", stopped: "neutral" } as const;

/** On a lead, person or deal: the sequences it's in, adding it to one, and stopping one (decision 497). */
export function SequencePanel({ organisationId, target, onChanged }: { organisationId: string; target: Target; onChanged?: () => void }) {
  const { canCrm } = useWorkspace();
  const enrolments = useApiData<{ enrolments: Enrolment[] }>("/api/crm/sequence-enrolments", { organisationId, ...target });
  const sequences = useApiData<{ sequences: Sequence[] }>("/api/crm/sequences", { organisationId });
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useBusy();
  const list = enrolments.data?.enrolments ?? [];
  const active = new Set(list.filter((entry) => entry.status === "active").map((entry) => entry.sequenceId));
  const options = (sequences.data?.sequences ?? []).filter((sequence) => sequence.isActive && !active.has(sequence.id));
  const changed = () => {
    enrolments.reload();
    onChanged?.();
  };
  if (list.length === 0 && (options.length === 0 || !canCrm("write"))) return null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.slice(0, 5).map((entry) => (
        <div key={entry.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <Badge tone={STATUS_TONES[entry.status]}>{entry.status === "active" ? "In sequence" : entry.status === "finished" ? "Finished" : "Stopped"}</Badge>
          <span>
            {entry.sequenceName} · step {entry.stepsDone} of {entry.stepsTotal} · from {formatDate(entry.startedOn)}
            {entry.stopReason ? <span className={ui.muted}> · {entry.stopReason}</span> : null}
          </span>
          {entry.status === "active" && canCrm("write") ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/api/crm/sequence-enrolments/${entry.id}/stop`, { method: "POST", body: { organisationId } });
                  changed();
                })
              }
            >
              Stop
            </Button>
          ) : null}
        </div>
      ))}
      {canCrm("write") && options.length > 0 ? (
        <span className={ui.rowButtons}>
          <select aria-label="Sequence" value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="">Add to a sequence…</option>
            {options.map((sequence) => (
              <option key={sequence.id} value={sequence.id}>
                {sequence.name}
              </option>
            ))}
          </select>
          <Button
            size="small"
            variant="secondary"
            disabled={busy || !choice}
            onClick={() =>
              void run(async () => {
                await api("/api/crm/sequence-enrolments", { method: "POST", body: { organisationId, sequenceId: choice, ...target } });
                setChoice("");
                changed();
              })
            }
          >
            Add
          </Button>
        </span>
      ) : null}
    </div>
  );
}
