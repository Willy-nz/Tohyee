"use client";

import { useState } from "react";
import { StageBadge, useBusy, useStages } from "@/components/crm";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import {
  categoriesFor,
  FORECAST_CATEGORIES,
  FORECAST_CATEGORY_LABELS,
  type ForecastCategory,
  type OpportunityStageSetup,
  STAGE_TYPE_LABELS,
  STAGE_TYPES,
  type StageType,
} from "@/lib/crm/forecast-figures";
import type { SalesProcess } from "@/lib/crm/stages";

/**
 * CRM › Stages (examples CRMS2, CRMS3, CRMS7), after Salesforce's Stage
 * picklist and sales processes: the organisation's opportunity stages in
 * order, each with its type, default probability and forecast category,
 * and which stages each opportunity record type uses. Admins and owners
 * only; the server checks again.
 */

type StageDraft = { name: string; type: StageType; probability: string; forecastCategory: ForecastCategory };

function fixedFor(type: StageType, draft: StageDraft): StageDraft {
  if (type === "won") return { ...draft, type, probability: "100", forecastCategory: "closed" };
  if (type === "lost") return { ...draft, type, probability: "0", forecastCategory: "omitted" };
  return { ...draft, type, forecastCategory: draft.forecastCategory === "closed" || draft.forecastCategory === "omitted" ? "pipeline" : draft.forecastCategory };
}

function StageFields({ draft, onChange, typeLocked }: { draft: StageDraft; onChange: (draft: StageDraft) => void; typeLocked: boolean }) {
  const open = draft.type === "open";
  return (
    <div className={ui.grid3}>
      <Field label="Stage">
        <input value={draft.name} maxLength={40} onChange={(event) => onChange({ ...draft, name: event.target.value })} required />
      </Field>
      <Field label="Type" hint={typeLocked ? "Opportunities are in it, so its type can't change." : undefined}>
        <select value={draft.type} disabled={typeLocked} onChange={(event) => onChange(fixedFor(event.target.value as StageType, draft))}>
          {STAGE_TYPES.map((type) => (
            <option key={type} value={type}>
              {STAGE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Probability (%)" hint="The default for opportunities moved here.">
        <input inputMode="numeric" className={ui.num} value={draft.probability} disabled={!open} onChange={(event) => onChange({ ...draft, probability: event.target.value })} />
      </Field>
      <Field label="Forecast category">
        <select value={draft.forecastCategory} disabled={!open} onChange={(event) => onChange({ ...draft, forecastCategory: event.target.value as ForecastCategory })}>
          {(open ? categoriesFor("open") : FORECAST_CATEGORIES.filter((c) => c === draft.forecastCategory)).map((category) => (
            <option key={category} value={category}>
              {FORECAST_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function StageRow({ organisationId, stage, first, last, onChanged }: { organisationId: string; stage: OpportunityStageSetup; first: boolean; last: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<StageDraft | null>(null);
  const { busy, error, run } = useBusy();
  const patch = (body: Record<string, unknown>) =>
    run(async () => {
      await api(`/api/crm/stages/${stage.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setEditing(null);
      onChanged();
    });
  return (
    <tr>
      <td colSpan={editing ? 6 : 1}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {editing ? (
          <form
            style={{ display: "grid", gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              void patch({ name: editing.name, type: editing.type, probability: editing.probability, forecastCategory: editing.forecastCategory });
            }}
          >
            <StageFields draft={editing} onChange={setEditing} typeLocked={stage.opportunityCount > 0} />
            <span className={ui.rowButtons}>
              <Button type="submit" size="small" disabled={busy}>
                Save
              </Button>
              <Button size="small" variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
            </span>
          </form>
        ) : (
          <>
            <StageBadge name={stage.name} type={stage.type} /> {stage.isActive ? null : <span className={ui.muted}>(archived)</span>}
            <div className={ui.muted}>Key: {stage.key}</div>
          </>
        )}
      </td>
      {editing ? null : (
        <>
          <td>{STAGE_TYPE_LABELS[stage.type]}</td>
          <td className={ui.num}>{stage.probability}%</td>
          <td>{FORECAST_CATEGORY_LABELS[stage.forecastCategory]}</td>
          <td className={ui.num}>{stage.opportunityCount}</td>
          <td>
            <span className={ui.rowButtons}>
              <Button size="small" variant="secondary" disabled={busy || first} onClick={() => void patch({ move: "up" })} aria-label={`Move ${stage.name} up`}>
                ↑
              </Button>
              <Button size="small" variant="secondary" disabled={busy || last} onClick={() => void patch({ move: "down" })} aria-label={`Move ${stage.name} down`}>
                ↓
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => setEditing({ name: stage.name, type: stage.type, probability: String(stage.probability), forecastCategory: stage.forecastCategory })}
              >
                Edit
              </Button>
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void patch({ isActive: !stage.isActive })}>
                {stage.isActive ? "Archive" : "Restore"}
              </Button>
            </span>
          </td>
        </>
      )}
    </tr>
  );
}

function NewStage({ organisationId, onSaved }: { organisationId: string; onSaved: () => void }) {
  const empty: StageDraft = { name: "", type: "open", probability: "10", forecastCategory: "pipeline" };
  const [draft, setDraft] = useState<StageDraft>(empty);
  const { busy, error, run } = useBusy();
  return (
    <form
      style={{ display: "grid", gap: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api("/api/crm/stages", { method: "POST", body: { organisationId, ...draft } });
          setDraft(empty);
          onSaved();
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <StageFields draft={draft} onChange={setDraft} typeLocked={false} />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !draft.name.trim()}>
          {busy ? "Adding…" : "Add stage"}
        </Button>
      </div>
    </form>
  );
}

function ProcessRow({ organisationId, process, stages, onChanged }: { organisationId: string; process: SalesProcess; stages: OpportunityStageSetup[]; onChanged: () => void }) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const { busy, error, run } = useBusy();
  const save = (stageKeys: string[] | null) =>
    run(async () => {
      await api(`/api/crm/sales-processes/${process.recordTypeId}`, { method: "PUT", body: { organisationId, stageKeys } });
      setPicked(null);
      onChanged();
    });
  const current = process.stageKeys;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <strong>
        {process.recordTypeName}
        {process.isActive ? "" : " (archived)"}
      </strong>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {picked ? (
        <>
          <div className={ui.rowButtons}>
            {stages
              .filter((stage) => stage.isActive || picked.includes(stage.key))
              .map((stage) => (
                <label key={stage.key} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={picked.includes(stage.key)}
                    onChange={(event) => setPicked(event.target.checked ? [...picked, stage.key] : picked.filter((key) => key !== stage.key))}
                  />
                  {stage.name}
                </label>
              ))}
          </div>
          <span className={ui.rowButtons}>
            <Button size="small" disabled={busy} onClick={() => void save(picked)}>
              Save
            </Button>
            <Button size="small" variant="secondary" disabled={busy} onClick={() => setPicked(null)}>
              Cancel
            </Button>
          </span>
        </>
      ) : (
        <span className={ui.rowButtons}>
          <span className={ui.muted}>
            {current === null ? "Every active stage" : stages.filter((stage) => current.includes(stage.key)).map((stage) => stage.name).join(", ")}
          </span>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => setPicked(current ?? stages.filter((stage) => stage.isActive).map((stage) => stage.key))}>
            Choose stages
          </Button>
          {current === null ? null : (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => void save(null)}>
              Use every stage
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

export function StagesManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const data = useStages(organisationId);
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can set up stages.</Notice>;
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const { stages, salesProcesses } = data.data;
  return (
    <>
      <Card
        title="Stages"
        description="In pipeline order. A Closed won stage is 100% and Closed (it can make the invoice); a Closed lost stage is 0% and Omitted. At least one active stage of each type must stay. Archived stages keep their opportunities. A new default probability doesn't change opportunities already in the stage."
      >
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Type</th>
                <th className={ui.num}>Probability</th>
                <th>Forecast category</th>
                <th className={ui.num}>Opportunities</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stages.map((stage, index) => (
                <StageRow
                  key={`${stage.id}:${stage.name}:${stage.sortOrder}:${stage.isActive}`}
                  organisationId={organisationId}
                  stage={stage}
                  first={index === 0}
                  last={index === stages.length - 1}
                  onChanged={data.reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Add a stage">
        <NewStage organisationId={organisationId} onSaved={data.reload} />
      </Card>
      <Card
        title="Sales processes"
        description="Which stages each opportunity record type uses, like Salesforce's sales processes. A process needs at least one Open, one Closed won and one Closed lost stage."
      >
        <div style={{ display: "grid", gap: 12 }}>
          {salesProcesses.map((process) => (
            <ProcessRow key={`${process.recordTypeId}:${(process.stageKeys ?? []).join(",")}`} organisationId={organisationId} process={process} stages={stages} onChanged={data.reload} />
          ))}
        </div>
      </Card>
    </>
  );
}
