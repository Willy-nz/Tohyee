"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useWorkspace } from "@/components/workspace";
import type { ShapeColumn, ShapeStep } from "@/lib/analytics/shaping";
import type { ShapedLoadRun, ShapedTable } from "@/lib/analytics/shaped-tables";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./analytics-shaping.module.css";

type TableInfo = { name: string; columns: ShapeColumn[] };
type ShapeOverview = { shapes: ShapedTable[]; tables: TableInfo[] };
type Preview = { columns: ShapeColumn[]; rows: Array<Record<string, string | null>> };
type StepKind = "filter" | "columns" | "rename" | "type" | "split" | "unpivot" | "group" | "calculated" | "merge" | "append";

const STEP_KINDS: Array<{ value: StepKind; label: string }> = [
  { value: "filter", label: "Filter rows" },
  { value: "columns", label: "Keep or remove columns" },
  { value: "rename", label: "Rename a column" },
  { value: "type", label: "Change a column type" },
  { value: "split", label: "Split a column" },
  { value: "unpivot", label: "Unpivot columns" },
  { value: "group", label: "Group and summarise" },
  { value: "calculated", label: "Add a calculated column" },
  { value: "merge", label: "Merge another table" },
  { value: "append", label: "Append another table" },
];

const TYPE_NAMES: Record<StepKind, string> = Object.fromEntries(STEP_KINDS.map(({ value, label }) => [value, label])) as Record<StepKind, string>;

function titleFor(step: ShapeStep, index: number): string {
  const column = "column" in step ? ` · ${step.column}` : "";
  return `${index + 1}. ${TYPE_NAMES[step.type]}${column}`;
}

function template(kind: StepKind, table: TableInfo | undefined, otherTable: string): Record<string, unknown> {
  const first = table?.columns[0]?.name ?? "column";
  const second = table?.columns[1]?.name ?? "other_column";
  switch (kind) {
    case "filter":
      return { type: kind, column: first, test: "is", value: "" };
    case "columns":
      return { type: kind, action: "keep", columns: [first] };
    case "rename":
      return { type: kind, column: first, name: "renamed_column" };
    case "type":
      return { type: kind, column: first, kind: "text" };
    case "split":
      return { type: kind, column: first, separator: "-", names: ["part_one", "part_two"] };
    case "unpivot":
      return { type: kind, columns: [first, second], attributeName: "attribute", valueName: "value" };
    case "group":
      return { type: kind, by: [first], aggregates: [{ operation: "count", name: "rows" }] };
    case "calculated":
      return { type: kind, name: "calculated_column", expression: { type: "text", parts: [{ type: "column", name: first }] } };
    case "merge":
      return { type: kind, table: otherTable, join: "left", matches: [{ column: first, withColumn: second }], columns: [] };
    case "append":
      return { type: kind, table: otherTable };
  }
}

function status(run: ShapedLoadRun | null): string {
  if (!run) return "Not rebuilt yet";
  return run.status === "ok" ? "Built" : run.status === "running" ? "Building…" : "Build failed";
}

export function AnalyticsShapingPage({ organisationId }: { organisationId: string }) {
  const modules = useModules(organisationId);
  const { can } = useWorkspace();
  const overview = useApiData<ShapeOverview>("/api/analytics/shaping", { organisationId });
  const confirm = useConfirm();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tableName, setTableName] = useState("");
  const [baseTable, setBaseTable] = useState("");
  const [steps, setSteps] = useState<ShapeStep[]>([]);
  const [selectedStep, setSelectedStep] = useState(-1);
  const [stepText, setStepText] = useState("");
  const [newStepKind, setNewStepKind] = useState<StepKind>("filter");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = can("admin");
  const data = overview.data;
  const activeShape = data?.shapes.find((shape) => shape.id === activeId);
  const isNew = activeId === "new";
  const availableTables = data?.tables ?? [];
  const effectiveBaseTable = baseTable || availableTables[0]?.name || "";
  const noBaseTable = !effectiveBaseTable || !availableTables.some((table) => table.name === effectiveBaseTable);
  const otherTables = availableTables.filter((table) => table.name !== effectiveBaseTable);
  const visiblePreviewError = noBaseTable ? "This base table is no longer loaded. Choose another table or reload the source." : previewError;

  useEffect(() => {
    // Previews run the steps, so only for people who can change shapes (admins).
    if (noBaseTable || !canManage) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      try {
        const result = await api<Preview>("/api/analytics/shaping/preview", {
          method: "POST",
          body: { organisationId, baseTable: effectiveBaseTable, steps, ...(selectedStep >= 0 ? { throughStep: selectedStep } : {}) },
        });
        if (!cancelled) {
          setPreview(result);
          setPreviewError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(errorMessage(caught));
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [canManage, effectiveBaseTable, noBaseTable, organisationId, selectedStep, steps]);

  if (!modules) return <p className={ui.muted}>Loading…</p>;
  if (!modules.analytics) {
    return (
      <Notice tone="info">
        Analytics is off.{" "}
        {can("admin") ? (
          <>
            Turn it on in <Link href="/operations/settings">Settings › Modules</Link>.
          </>
        ) : (
          "An admin can turn it on in Settings."
        )}
      </Notice>
    );
  }
  if (overview.error) return <Notice tone="error">{overview.error}</Notice>;
  if (!data) return <p className={ui.muted}>Loading…</p>;

  function beginNew() {
    setActiveId("new");
    setName("");
    setTableName("");
    setBaseTable(availableTables[0]?.name ?? "");
    setSteps([]);
    setSelectedStep(-1);
    setStepText("");
    setMessage(null);
  }

  function selectShape(shape: ShapedTable) {
    setActiveId(shape.id);
    setName(shape.name);
    setTableName(shape.tableName);
    setBaseTable(shape.baseTable);
    setSteps(shape.steps);
    setSelectedStep(shape.steps.length ? 0 : -1);
    setStepText(shape.steps.length ? JSON.stringify(shape.steps[0], null, 2) : "");
    setMessage(null);
  }

  function addStep() {
    const table = availableTables.find((candidate) => candidate.name === effectiveBaseTable);
    const otherTable = otherTables[0]?.name ?? "";
    const step = template(newStepKind, table, otherTable) as ShapeStep;
    const next = [...steps, step];
    setSteps(next);
    setSelectedStep(next.length - 1);
    setStepText(JSON.stringify(step, null, 2));
    setMessage(null);
  }

  function editStep(value: string) {
    setStepText(value);
    try {
      const parsed = JSON.parse(value) as ShapeStep;
      const next = steps.slice();
      next[selectedStep] = parsed;
      setSteps(next);
      setMessage(null);
    } catch {
      setMessage({ tone: "error", text: "The step isn't valid JSON yet. Finish editing it before saving or previewing." });
    }
  }

  function moveStep(index: number, offset: number) {
    const next = steps.slice();
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setSteps(next);
    const selected = selectedStep === index ? index + offset : selectedStep === index + offset ? index : selectedStep;
    setSelectedStep(selected);
    setStepText(selected >= 0 ? JSON.stringify(next[selected], null, 2) : "");
  }

  function removeStep(index: number) {
    const next = steps.filter((_, current) => current !== index);
    setSteps(next);
    const selected = next.length ? Math.min(index, next.length - 1) : -1;
    setSelectedStep(selected);
    setStepText(selected >= 0 ? JSON.stringify(next[selected], null, 2) : "");
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const body = { organisationId, name, tableName, baseTable, steps };
      const path = isNew ? "/api/analytics/shaping" : `/api/analytics/shaping/${activeId}`;
      const result = isNew
        ? await api<{ shape: ShapedTable; run: ShapedLoadRun }>(path, { method: "POST", body })
        : await api<{ shape: ShapedTable; run: ShapedLoadRun }>(path, { method: "PATCH", body });
      setActiveId(result.shape.id);
      setMessage(
        result.run.status === "ok"
          ? { tone: "success", text: `Built ${result.run.rowsLoaded ?? "0"} rows in ${result.run.milliseconds ?? 0} ms.` }
          : { tone: "error", text: `The steps were saved, but the table wasn't rebuilt: ${result.run.error}. The previous table is still there.` },
      );
      overview.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function rebuild(shape: ShapedTable) {
    setBusy(true);
    try {
      const { run } = await api<{ run: ShapedLoadRun }>(`/api/analytics/shaping/${shape.id}/load`, {
        method: "POST",
        body: { organisationId },
      });
      setMessage(
        run.status === "ok"
          ? { tone: "success", text: `Rebuilt ${run.rowsLoaded ?? "0"} rows.` }
          : { tone: "error", text: `The table wasn't rebuilt: ${run.error}. The previous table is still there.` },
      );
      overview.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(shape: ShapedTable) {
    const confirmed = await confirm("The output table will be removed, but its load history stays.", {
      title: `Remove ${shape.name}?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/analytics/shaping/${shape.id}`, { method: "DELETE", query: { organisationId } });
      setActiveId(null);
      overview.reload();
      setMessage({ tone: "success", text: `${shape.name} was removed.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <>
      <div className={styles.shapeList} aria-label="Shaped tables">
        {data.shapes.map((shape) => (
          <button key={shape.id} className={styles.shapeItem} aria-pressed={activeId === shape.id} onClick={() => selectShape(shape)}>
            <strong>{shape.name}</strong>
            <span className={styles.muted}>
              {shape.tableName} · {status(shape.lastLoad)}
            </span>
          </button>
        ))}
        {canManage ? <Button variant="secondary" onClick={beginNew}>New shaped table</Button> : null}
      </div>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {availableTables.length === 0 ? (
        <Notice tone="info">
          No tables are loaded yet. Load a CSV or use Refresh now under <Link href="/analytics/sources">Data sources</Link> first.
        </Notice>
      ) : null}
      {activeShape && canManage ? (
        <div className={styles.actions}>
          <Button size="small" variant="secondary" onClick={() => void rebuild(activeShape)} disabled={busy}>
            Rebuild now
          </Button>
          <Button size="small" variant="danger" onClick={() => void remove(activeShape)} disabled={busy}>
            Remove
          </Button>
        </div>
      ) : null}

      {isNew || activeShape ? (
        <>
          <Card title="Shaped table">
            <div className={styles.definition}>
              <Field label="Name">
                <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Output table">
                <input value={tableName} maxLength={63} onChange={(event) => setTableName(event.target.value)} disabled={!canManage || Boolean(activeShape)} />
              </Field>
              <Field label="Base table">
                <select value={effectiveBaseTable} onChange={(event) => setBaseTable(event.target.value)} disabled={!canManage}>
                {availableTables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
                </select>
              </Field>
            </div>
            {canManage && (isNew || activeShape) ? (
              <div className={styles.actions}>
                <Button onClick={() => void save()} disabled={busy || !name.trim() || !tableName.trim() || !baseTable}>
                  {busy ? "Saving…" : isNew ? "Create and build" : "Save and rebuild"}
                </Button>
                {isNew ? <Button variant="secondary" onClick={() => setActiveId(null)}>Cancel</Button> : null}
              </div>
            ) : null}
          </Card>

          <div className={styles.workspace}>
            <Card title="Applied steps" description="Each step uses the columns produced by the step above it.">
              <div className={styles.stepList}>
                {steps.map((step, index) => (
                  <div key={`${index}-${step.type}`} className={styles.step} aria-current={selectedStep === index ? "step" : undefined}>
                    <button
                      className={styles.stepSelect}
                      onClick={() => {
                        setSelectedStep(index);
                        setStepText(JSON.stringify(step, null, 2));
                      }}
                    >
                      {titleFor(step, index)}
                    </button>
                    {canManage ? (
                      <div className={styles.stepTools}>
                        <Button size="small" variant="secondary" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</Button>
                        <Button size="small" variant="secondary" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}>↓</Button>
                        <Button size="small" variant="danger" aria-label={`Remove step ${index + 1}`} onClick={() => removeStep(index)}>×</Button>
                      </div>
                    ) : null}
                  </div>
                ))}
                {steps.length === 0 ? <Empty>No steps yet. Start with a filter or choose any shaping operation.</Empty> : null}
                {canManage ? (
                  <div className={styles.addStep}>
                    <select aria-label="Step to add" value={newStepKind} onChange={(event) => setNewStepKind(event.target.value as StepKind)}>
                      {STEP_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                    </select>
                    <Button size="small" variant="secondary" onClick={addStep}>Add step</Button>
                  </div>
                ) : null}
              </div>
            </Card>

            <div className={styles.rightPane}>
              {selectedStep >= 0 ? (
                <Card title={`Edit step ${selectedStep + 1}`} description="Edit the step settings below. Names and values are validated; SQL and formulas are not accepted.">
                  <Field label="Step settings (JSON)">
                    <textarea
                      className={styles.stepEditor}
                      value={stepText}
                      onChange={(event) => editStep(event.target.value)}
                      spellCheck={false}
                      readOnly={!canManage}
                    />
                  </Field>
                </Card>
              ) : null}
              <Card
                title="Preview"
                description={selectedStep >= 0 ? `First 100 rows after step ${selectedStep + 1}.` : "First 100 rows from the selected base table."}
              >
                {visiblePreviewError ? <Notice tone="error">{visiblePreviewError}</Notice> : null}
                {preview ? (
                  <div className={styles.previewTable}>
                    <table>
                      <thead>
                        <tr>{preview.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, index) => (
                          <tr key={index}>{preview.columns.map((column) => <td key={column.name}>{row[column.name] ?? ""}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.rows.length === 0 ? <p className={ui.muted}>No rows match these steps.</p> : null}
                    {preview.rows.length === 100 ? <p className={styles.muted}>Showing the first 100 rows.</p> : null}
                  </div>
                ) : !previewError ? <p className={ui.muted}>Loading preview…</p> : null}
              </Card>
              {activeShape?.lastLoad ? (
                <p className={ui.muted}>
                  Last build: <Badge tone={activeShape.lastLoad.status === "ok" ? "green" : activeShape.lastLoad.status === "failed" ? "red" : "blue"}>
                    {status(activeShape.lastLoad)}
                  </Badge>
                  {activeShape.lastLoad.error ? ` ${activeShape.lastLoad.error}` : ""}
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : data.shapes.length ? (
        <Notice tone="info">Choose a shaped table to see its steps and preview.</Notice>
      ) : canManage ? (
        <Notice tone="info">Create a shaped table to start applying steps to a loaded table.</Notice>
      ) : null}
    </>
  );
}
