"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime, personName } from "@/lib/format";
import type { CashFlowFigureRow, CashFlowFigures } from "@/lib/reports/cash-flow-layout";
import type { AnyCustomReportFigures, CustomReport } from "@/lib/reports/custom";
import {
  CASH_FLOW_END_LABELS,
  CASH_FLOW_SECTIONS,
  type CashFlowEndLabels,
  type CashFlowLayout,
  type CashFlowRow,
  type CashFlowSection,
  type CashFlowSectionKind,
  lastDayOfMonth,
} from "@/lib/reports/custom-layout";
import { statementAmount } from "@/lib/reports/statement-format";

type Loaded = { report: CustomReport; figures: AnyCustomReportFigures };

let counter = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter += 1)}`;

/** Every line the statement has, with its name, from the figures (placed or not). */
function knownLines(figures: CashFlowFigures): Array<{ ref: string; label: string }> {
  const seen = new Map<string, string>();
  for (const block of figures.blocks)
    if (block.kind === "section") for (const row of block.rows) for (const line of row.lines) if (!seen.has(line.ref)) seen.set(line.ref, line.label);
  return [...seen.entries()].map(([ref, label]) => ({ ref, label }));
}

function move<T>(list: T[], index: number, by: number): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

function Amount({ value }: { value: string | null | undefined }) {
  return <>{value == null ? "" : statementAmount(value)}</>;
}

/** The figures as the statement shows them: sections, rows (hidden ones greyed in the editor), totals and the last lines. */
export function CashFlowTable({ figures, showHidden }: { figures: CashFlowFigures; showHidden: boolean }) {
  const columns = figures.columns;
  const row = (entry: CashFlowFigureRow) => {
    if (entry.hidden && !showHidden) return null;
    const muted = entry.hidden ? { opacity: 0.5 } : undefined;
    if (entry.kind === "heading")
      return (
        <tr key={entry.id} className={ui.reportHeading} style={muted}>
          <td colSpan={columns.length + 1}>{entry.label}</td>
        </tr>
      );
    return [
      ...(entry.showLines
        ? entry.lines.map((line) => (
            <tr key={`${entry.id}:${line.ref}`} className={ui.reportSection} style={muted}>
              <td style={{ paddingLeft: 44 }}>{line.label}</td>
              {columns.map((column) => (
                <td key={column.key} className={ui.num}>
                  <Amount value={line.values[column.key]} />
                </td>
              ))}
            </tr>
          ))
        : []),
      <tr key={entry.id} className={entry.showLines ? ui.reportTotal : ui.reportSection} style={muted}>
        <td>
          {entry.showLines ? `Total ${entry.label}` : entry.label}
          {entry.note ? <div className={ui.muted}>{entry.note}</div> : null}
        </td>
        {columns.map((column) => (
          <td key={column.key} className={ui.num}>
            <Amount value={entry.values[column.key]} />
          </td>
        ))}
      </tr>,
    ];
  };
  return (
    <div className={ui.statementWrap}>
      <table className={`${ui.table} ${ui.statement}`}>
        <thead>
          <tr>
            <th>
              <span className={ui.srOnly}>Item</span>
            </th>
            {columns.map((column) => (
              <th key={column.key} className={ui.num}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {figures.blocks.map((block) =>
            block.kind === "text" ? (
              <tr key={block.id}>
                <td colSpan={columns.length + 1} className={ui.reportNote}>
                  {block.text}
                </td>
              </tr>
            ) : (
              [
                <tr key={`h-${block.id}`} className={ui.reportHeading}>
                  <td colSpan={columns.length + 1}>{block.title}</td>
                </tr>,
                ...block.rows.map(row),
                <tr key={`t-${block.id}`} className={ui.reportTotal}>
                  <td>{block.total.label}</td>
                  {columns.map((column) => (
                    <td key={column.key} className={ui.num}>
                      <Amount value={block.total.values[column.key]} />
                    </td>
                  ))}
                </tr>,
              ]
            ),
          )}
        </tbody>
        <tfoot>
          {figures.end.map((line) => (
            <tr key={line.key} className={line.key === "closingCash" ? ui.reportGrand : line.key === "netChange" ? ui.reportTotal : undefined}>
              <td>{line.label}</td>
              {columns.map((column) => (
                <td key={column.key} className={ui.num}>
                  <Amount value={line.values[column.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

/**
 * A cash flows custom report (CFL1-CFL5): its figures, and for a draft the
 * layout editor: sections, headings and groups to rename, reorder, hide or
 * note, lines to group or move between sections, the last lines' names, the
 * periods, then Save, Publish and Set as default layout.
 */
export function CashFlowCustomReportPage({ organisationId, loaded }: { organisationId: string; loaded: Loaded }) {
  const router = useRouter();
  const { can, current } = useWorkspace();
  const defaults = useApiData<{ defaults: Array<{ base: string; reportId: string }> }>("/api/report-layouts", { organisationId });
  const [saved, setSaved] = useState(loaded);
  const [draft, setDraft] = useState<CashFlowLayout | null>(null);
  const [preview, setPreview] = useState<CashFlowFigures | null>(null);
  const [defaultsOverride, setDefaultsOverride] = useState<Array<{ base: string; reportId: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishKey, setPublishKey] = useState(() => newIdempotencyKey("custom-report-publish"));
  const report = saved.report as CustomReport & { layout: CashFlowLayout };
  const layout = draft ?? report.layout;
  const figures = preview ?? (saved.figures as CashFlowFigures);
  const editable = report.kind === "draft" && !report.archivedAt && can("bookkeeper");
  const isDefault = (defaultsOverride ?? defaults.data?.defaults ?? []).some((entry) => entry.reportId === report.id);
  const lines = knownLines(saved.figures as CashFlowFigures);
  const labelOf = (ref: string) => lines.find((line) => line.ref === ref)?.label ?? ref;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Changes a copy of the layout, unsaved, and shows its figures. */
  function change(apply: (next: CashFlowLayout) => void) {
    const next = structuredClone(layout);
    apply(next);
    void run(async () => {
      const result = await api<{ figures: CashFlowFigures }>(`/api/custom-reports/${report.id}/preview`, { method: "POST", body: { organisationId, layout: next } });
      setDraft(next);
      setPreview(result.figures);
    });
  }
  const sections = (next: CashFlowLayout) => next.blocks.filter((block): block is CashFlowSection => block.kind === "section");
  const sectionOf = (next: CashFlowLayout, id: string) => sections(next).find((section) => section.id === id)!;
  const takeOut = (next: CashFlowLayout, ref: string) => {
    for (const section of sections(next)) for (const row of section.rows) if (row.kind === "group") row.lines = row.lines.filter((entry) => entry !== ref);
  };
  const editRow = (sectionId: string, rowId: string, edit: (row: CashFlowRow) => void) =>
    change((next) => {
      const row = sectionOf(next, sectionId).rows.find((entry) => entry.id === rowId);
      if (row) edit(row);
    });

  async function save() {
    await run(async () => {
      const result = await api<Loaded>(`/api/custom-reports/${report.id}`, { method: "PUT", body: { organisationId, layout, version: report.version } });
      setSaved(result);
      setDraft(null);
      setPreview(null);
      setMessage("Saved.");
    });
  }

  const endLabels: CashFlowEndLabels = { ...CASH_FLOW_END_LABELS, ...(layout.endLabels ?? {}) };

  return (
    <>
      <div className={ui.actions} data-print="hide">
        <Link href={`/operations/reports?view=${report.archivedAt ? "archived" : report.kind === "published" ? "published" : "drafts"}`}>← Reports</Link>
        {report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}
        {isDefault ? <Badge tone="green">Default layout</Badge> : null}
        {report.archivedAt ? <Badge tone="amber">Archived</Badge> : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {!figures.reconciles ? <Notice tone="warning">Cash at the end doesn&apos;t match the bank accounts. Check for journals that move cash in an unusual way.</Notice> : null}
      {report.kind === "published" ? (
        <Notice tone="info">
          A frozen copy, published {formatDateTime(report.publishedAt)} by {personName(report, "publishedBy")}.{" "}
          {report.publishedFromId ? <Link href={`/operations/reports/custom/${report.publishedFromId}`}>Open its draft</Link> : null}
        </Notice>
      ) : null}
      <div className={ui.toolbar} data-print="hide">
        {editable ? (
          <>
            <Button size="small" disabled={busy || !draft} onClick={() => void save()}>
              {draft ? "Save" : "Saved"}
            </Button>
            {draft ? (
              <Button size="small" variant="secondary" disabled={busy} onClick={() => (setDraft(null), setPreview(null))}>
                Undo changes
              </Button>
            ) : null}
            <Button
              size="small"
              variant="secondary"
              disabled={busy || Boolean(draft)}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ defaults: Array<{ base: string; reportId: string }> }>("/api/report-layouts", {
                    method: "PUT",
                    body: { organisationId, base: "cash_flows", reportId: isDefault ? null : report.id },
                  });
                  setDefaultsOverride(result.defaults);
                  setMessage(isDefault ? "Reports shows the standard cash flows again." : "Reports and the annual financial statements now show cash flows in this layout.");
                })
              }
            >
              {isDefault ? "Stop using as default" : "Set as default layout"}
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy || Boolean(draft)}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/publish`, {
                    method: "POST",
                    body: { organisationId, source: "ui", idempotencyKey: publishKey },
                  });
                  setPublishKey(newIdempotencyKey("custom-report-publish"));
                  router.push(`/operations/reports/custom/${result.report.id}`);
                })
              }
            >
              Publish
            </Button>
          </>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        {can("bookkeeper") ? (
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/archive`, {
                  method: "POST",
                  body: { organisationId, archived: !report.archivedAt },
                });
                setSaved({ ...saved, report: result.report });
              })
            }
          >
            {report.archivedAt ? "Bring back" : "Archive"}
          </Button>
        ) : null}
      </div>

      <article className={ui.reportPaper}>
        <header className={ui.reportPaperHeader}>
          <h2 className={ui.reportPaperTitle}>{layout.title}</h2>
          <p className={ui.reportPaperMeta}>
            {current?.displayName}
            <br />
            Statement of cash flows · {figures.currencyCode}
          </p>
        </header>
        <CashFlowTable figures={figures} showHidden={editable} />
      </article>

      {editable ? (
        <div data-print="hide" style={{ display: "grid", gap: 16, marginTop: 16 }}>
          <Card title="Title and periods">
            <div className={ui.inlineForm}>
              <Field label="Title">
                <input
                  key={`t-${layout.title}`}
                  defaultValue={layout.title}
                  maxLength={200}
                  onBlur={(event) => event.target.value.trim() && event.target.value.trim() !== layout.title && change((next) => void (next.title = event.target.value.trim()))}
                />
              </Field>
              <Field label="Last period ends" hint="The last day of a month">
                <input
                  type="date"
                  value={layout.columns.periodEnd}
                  onChange={(event) => event.target.value && change((next) => void (next.columns.periodEnd = lastDayOfMonth(event.target.value)))}
                />
              </Field>
              <Field label="Each period is a">
                <select
                  value={layout.columns.periodLength}
                  onChange={(event) => change((next) => void (next.columns.periodLength = event.target.value as CashFlowLayout["columns"]["periodLength"]))}
                >
                  <option value="month">Month</option>
                  <option value="quarter">Quarter</option>
                  <option value="year">Year</option>
                </select>
              </Field>
              <Field label="Periods">
                <select value={layout.columns.periodCount} onChange={(event) => change((next) => void (next.columns.periodCount = Number(event.target.value)))}>
                  {[1, 2, 3, 4, 5, 6, 12].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          {layout.blocks.map((block, blockIndex) =>
            block.kind === "text" ? (
              <Card key={block.id} title="Note">
                <textarea
                  key={`n-${block.text}`}
                  rows={3}
                  defaultValue={block.text}
                  maxLength={5000}
                  onBlur={(event) =>
                    event.target.value.trim() &&
                    event.target.value !== block.text &&
                    change((next) => void ((next.blocks[blockIndex] as { text: string }).text = event.target.value.trim()))
                  }
                />
                <div className={ui.rowButtons}>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void (next.blocks = move(next.blocks, blockIndex, -1)))}>
                    Move up
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void (next.blocks = move(next.blocks, blockIndex, 1)))}>
                    Move down
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void next.blocks.splice(blockIndex, 1))}>
                    Remove note
                  </Button>
                </div>
              </Card>
            ) : (
              <Card
                key={block.id}
                title={block.title}
                description={`Lines that usually sit in ${CASH_FLOW_SECTIONS[block.usual].toLowerCase()} and aren't placed elsewhere show here on their own.`}
              >
                <div className={ui.inlineForm}>
                  <Field label="Section name">
                    <input
                      key={`s-${block.title}`}
                      defaultValue={block.title}
                      maxLength={120}
                      onBlur={(event) => event.target.value.trim() && change((next) => void (sectionOf(next, block.id).title = event.target.value.trim()))}
                    />
                  </Field>
                  <Field label="Its total">
                    <input
                      key={`st-${block.totalLabel}`}
                      defaultValue={block.totalLabel}
                      maxLength={120}
                      onBlur={(event) => event.target.value.trim() && change((next) => void (sectionOf(next, block.id).totalLabel = event.target.value.trim()))}
                    />
                  </Field>
                  <Field label="Usually holds">
                    <select value={block.usual} onChange={(event) => change((next) => void (sectionOf(next, block.id).usual = event.target.value as CashFlowSectionKind))}>
                      {Object.entries(CASH_FLOW_SECTIONS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className={ui.rowButtons}>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void (next.blocks = move(next.blocks, blockIndex, -1)))}>
                    Move section up
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void (next.blocks = move(next.blocks, blockIndex, 1)))}>
                    Move section down
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => change((next) => void sectionOf(next, block.id).rows.push({ id: newId("g"), kind: "group", label: "New group", lines: [], showLines: false }))}
                  >
                    Add a group
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => change((next) => void sectionOf(next, block.id).rows.push({ id: newId("h"), kind: "heading", label: "New heading" }))}
                  >
                    Add a heading
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => change((next) => void next.blocks.splice(blockIndex, 1))}>
                    Remove section
                  </Button>
                </div>
                <ol style={{ display: "grid", gap: 12, paddingLeft: 20 }}>
                  {block.rows.map((row, rowIndex) => (
                    <li key={row.id}>
                      <div className={ui.inlineForm}>
                        <Field label={row.kind === "heading" ? "Heading" : "Group name"}>
                          <input
                            key={`r-${row.label}`}
                            defaultValue={row.label}
                            maxLength={120}
                            onBlur={(event) => event.target.value.trim() && editRow(block.id, row.id, (target) => void (target.label = event.target.value.trim()))}
                          />
                        </Field>
                        <Field label="Note under it">
                          <input
                            key={`rn-${row.note ?? ""}`}
                            defaultValue={row.note ?? ""}
                            maxLength={500}
                            onBlur={(event) =>
                              event.target.value !== (row.note ?? "") && editRow(block.id, row.id, (target) => void (target.note = event.target.value.trim() || undefined))
                            }
                          />
                        </Field>
                        <label className={ui.checkbox}>
                          <input
                            type="checkbox"
                            checked={Boolean(row.hidden)}
                            onChange={(event) => editRow(block.id, row.id, (target) => void (target.hidden = event.target.checked || undefined))}
                          />{" "}
                          Hidden
                        </label>
                        {row.kind === "group" ? (
                          <label className={ui.checkbox}>
                            <input
                              type="checkbox"
                              checked={row.showLines}
                              onChange={(event) => editRow(block.id, row.id, (target) => void (target.kind === "group" && (target.showLines = event.target.checked)))}
                            />{" "}
                            Show its lines
                          </label>
                        ) : null}
                      </div>
                      {row.kind === "group" ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          {row.lines.map((ref) => (
                            <div key={ref} className={ui.rowButtons}>
                              <span>{labelOf(ref)}</span>
                              <Button
                                size="small"
                                variant="secondary"
                                onClick={() =>
                                  editRow(block.id, row.id, (target) => void (target.kind === "group" && (target.lines = target.lines.filter((entry) => entry !== ref))))
                                }
                              >
                                Take out
                              </Button>
                            </div>
                          ))}
                          <Field label="Add a line">
                            <select
                              value=""
                              onChange={(event) => {
                                const ref = event.target.value;
                                if (!ref) return;
                                change((next) => {
                                  takeOut(next, ref);
                                  const target = sectionOf(next, block.id).rows.find((entry) => entry.id === row.id);
                                  if (target?.kind === "group") target.lines.push(ref);
                                });
                              }}
                            >
                              <option value="">Choose a line (moves it here)</option>
                              {lines
                                .filter((line) => !row.lines.includes(line.ref))
                                .map((line) => (
                                  <option key={line.ref} value={line.ref}>
                                    {line.label}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        </div>
                      ) : null}
                      <div className={ui.rowButtons}>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => change((next) => void (sectionOf(next, block.id).rows = move(sectionOf(next, block.id).rows, rowIndex, -1)))}
                        >
                          Move up
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => change((next) => void (sectionOf(next, block.id).rows = move(sectionOf(next, block.id).rows, rowIndex, 1)))}
                        >
                          Move down
                        </Button>
                      </div>
                      <div className={ui.inlineForm}>
                        <Field label="Move to section">
                          <select
                            value={block.id}
                            onChange={(event) =>
                              change((next) => {
                                const from = sectionOf(next, block.id);
                                const [taken] = from.rows.splice(rowIndex, 1);
                                sectionOf(next, event.target.value).rows.push(taken);
                              })
                            }
                          >
                            {sections(layout).map((section) => (
                              <option key={section.id} value={section.id}>
                                {section.title}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Button size="small" variant="secondary" onClick={() => change((next) => void sectionOf(next, block.id).rows.splice(rowIndex, 1))}>
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            ),
          )}

          <div className={ui.rowButtons}>
            <Button
              variant="secondary"
              onClick={() =>
                change(
                  (next) => void next.blocks.push({ id: newId("s"), kind: "section", usual: "operating", title: "New section", totalLabel: "Net cash from new section", rows: [] }),
                )
              }
            >
              Add a section
            </Button>
            <Button variant="secondary" onClick={() => change((next) => void next.blocks.push({ id: newId("n"), kind: "text", text: "A note." }))}>
              Add a note
            </Button>
          </div>

          <Card title="The last lines" description="Their names can change. They're always shown, and always add up.">
            <div className={ui.inlineForm}>
              {(Object.keys(CASH_FLOW_END_LABELS) as Array<keyof CashFlowEndLabels>).map((key) => (
                <Field key={key} label={CASH_FLOW_END_LABELS[key]}>
                  <input
                    key={`e-${endLabels[key]}`}
                    defaultValue={endLabels[key]}
                    maxLength={120}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value && value !== endLabels[key]) change((next) => void (next.endLabels = { ...(next.endLabels ?? {}), [key]: value }));
                    }}
                  />
                </Field>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
      {busy ? <p className={ui.muted}>Working…</p> : null}
    </>
  );
}
