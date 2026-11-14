"use client";

import Link from "next/link";
import { Fragment, type KeyboardEvent, type ReactNode, useState } from "react";
import { Money } from "@/components/books";
import { MoreMenu, type MoreMenuItem } from "@/components/more-menu";
import { ui } from "@/components/ui";
import { accountTransactionsHref } from "@/lib/reports/drilldown";
import type { ComputedBlock, ComputedRow, CustomReportFigures, ReportColumn, ReportTrackingFilter, ReportValues } from "@/lib/reports/custom-layout";

/**
 * A custom report's table in statement style (decisions 1351, 1356, 1360):
 * the same look as the standard reports, amounts that open their
 * transactions, hidden rows left out, notes under their rows and page breaks
 * for printing and PDF. With `editor`, each row also gets a drag handle
 * (Up and Down arrow keys move it too), its name typed in place, a "⋯" menu,
 * and tick boxes to group accounts. An account drags onto another group to
 * move it there, as in Xero's layout editor (CR21, decision 1614); ticked
 * accounts can also be moved with "Move to", for the keyboard and touch.
 */

/**
 * The accounts being dragged: the table and group they're in and the codes
 * moving (the ticked ones when the dragged one is ticked). Kept here, not in
 * the drag's own data, because a page can't read that data while dragging
 * over a row, only on the drop; the drag carries the account's name as text.
 */
type AccountDrag = { tableId: string; rowId: string; codes: string[] };
const accountDrag: { current: AccountDrag | null } = { current: null };
function holdAccountDrag(drag: AccountDrag | null): void {
  accountDrag.current = drag;
}

export type RowEditor = {
  busy: boolean;
  rename: (rowId: string, label: string) => void;
  move: (rowId: string, toIndex: number) => void;
  rowMenu: (row: ComputedRow) => MoreMenuItem[];
  /** Groups these accounts (by code) of a group row as a new group (CR16). */
  group: (rowId: string, codes: string[], label: string) => void;
  /** Moves these accounts (by code) from one group to another in the same table (CR21). */
  moveAccounts?: (fromRowId: string, codes: string[], toRowId: string) => void;
  /** The layout editor (LE1): clicking a row picks it, to change it in Details. */
  select?: (rowId: string) => void;
  selectedId?: string | null;
  /** Clicking a column heading picks the columns. */
  selectColumns?: () => void;
};

/** A click on a control inside a row is the control's, not a pick of the row. */
const onControl = (target: EventTarget | null) => target instanceof Element && target.closest("button, a, select, textarea, [role=menu], [role=menuitem]") !== null;

const ZERO = /^-?0*(\.0*)?$/;

type CellAccounts = { accountId?: string; accountIds?: string[] };

function Cell({
  column,
  values,
  format,
  accounts,
  filter,
  blankZero = false,
}: {
  column: ReportColumn;
  values: ReportValues;
  format?: ComputedRow["format"];
  accounts?: CellAccounts;
  filter?: ReportTrackingFilter | null;
  blankZero?: boolean;
}) {
  const value = values[column.key] ?? null;
  // A Notes column's text (LE7).
  if (column.format === "text") return <td className={ui.layoutNotesCell}>{value ?? ""}</td>;
  if (column.kind === "percent" || column.format === "percent" || (format === "percent" && column.kind !== "difference")) {
    return <td className={ui.num}>{value == null ? "" : `${value}%`}</td>;
  }
  if (value == null) return <td className={ui.num} />;
  const linkable =
    format !== "percent" &&
    format !== "number" &&
    accounts &&
    (accounts.accountId || (accounts.accountIds && accounts.accountIds.length > 0)) &&
    column.to &&
    column.drillFrom !== undefined &&
    (column.kind === "period" || column.kind === "year_to_date" || column.kind === "date") &&
    !ZERO.test(value);
  return (
    <td className={ui.num}>
      {linkable ? (
        <Link
          href={accountTransactionsHref({
            ...accounts,
            from: column.drillFrom,
            to: column.to!,
            trackingCategoryId: filter?.categoryId,
            trackingValueId: filter?.valueId,
          })}
        >
          <Money value={value} />
        </Link>
      ) : (
        <Money value={value} blankZero={blankZero} />
      )}
    </td>
  );
}

function RowName({ row, editor, position, count }: { row: ComputedRow; editor?: RowEditor; position: number; count: number }) {
  const [label, setLabel] = useState(row.label);
  if (!editor) return <>{row.label}</>;
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      editor.move(row.id, position + (event.key === "ArrowUp" ? -1 : 1));
    }
  };
  return (
    <span className={ui.layoutRowName}>
      <button
        type="button"
        className={ui.dragHandle}
        draggable
        disabled={editor.busy}
        aria-label={`Move ${row.label}, row ${position + 1} of ${count}. Up and Down arrows move it.`}
        title="Drag, or use the Up and Down arrows, to move"
        onKeyDown={onKey}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", row.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        data-export-ignore
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <input
        className={ui.layoutRowInput}
        aria-label={`Name of row ${position + 1}`}
        value={label}
        maxLength={200}
        disabled={editor.busy}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setLabel(row.label);
        }}
        onBlur={() => {
          if (label.trim() && label.trim() !== row.label) editor.rename(row.id, label.trim());
          else setLabel(row.label);
        }}
      />
      {row.hidden ? <span className={ui.muted}> (hidden)</span> : null}
    </span>
  );
}

/** A table of a custom report, or of the standard report in its default layout. */
export function CustomFiguresTable({
  id,
  block,
  figures,
  filter,
  editor,
}: {
  id: string;
  block: Extract<ComputedBlock, { kind: "table" }>;
  figures: CustomReportFigures;
  filter?: ReportTrackingFilter | null;
  editor?: RowEditor;
}) {
  const columns = figures.columns;
  const span = columns.length + 1 + (editor ? 1 : 0);
  const [selected, setSelected] = useState<{
    rowId: string;
    codes: string[];
  } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);
  /** The group an account is being dragged over. */
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const groups = block.rows.filter((row) => row.kind === "group");
  const canMoveAccounts = Boolean(editor?.moveAccounts) && groups.length > 1;
  const draggingAccounts = () => accountDrag.current?.tableId === id;
  const startAccountDrag = (event: React.DragEvent, rowId: string, code: string, name: string, ticked: string[]) => {
    holdAccountDrag({ tableId: id, rowId, codes: ticked.includes(code) ? ticked : [code] });
    event.dataTransfer.setData("text/plain", name);
    event.dataTransfer.effectAllowed = "move";
  };
  const endAccountDrag = () => {
    holdAccountDrag(null);
    setDropGroup(null);
  };
  /** Dropping an account on any row of a group moves it into that group. */
  const accountDrop = (groupId: string) =>
    canMoveAccounts
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!draggingAccounts()) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setDropGroup(groupId);
          },
          onDragLeave: () => setDropGroup((current) => (current === groupId ? null : current)),
          onDrop: (event: React.DragEvent) => {
            const carried = accountDrag.current;
            if (!carried || carried.tableId !== id) return;
            event.preventDefault();
            event.stopPropagation();
            endAccountDrag();
            if (carried.rowId !== groupId && carried.codes.length > 0) {
              editor!.moveAccounts!(carried.rowId, carried.codes, groupId);
              setSelected(null);
            }
          },
        }
      : {};
  // Hidden rows, and groups with nothing in these periods, are left out of the report (as Xero leaves out empty sections).
  // Accounts with nothing in these columns are only listed in the editor, to be moved (CR23).
  const linesOf = (row: ComputedRow) => (editor ? row.lines : row.lines.filter((line) => !line.empty));
  const rows = editor ? block.rows : block.rows.filter((row) => !row.hidden && !(row.kind === "group" && row.showAccounts && linesOf(row).length === 0));
  // The last money formula (net profit, total equity) gets the double line.
  const lastFormula = [...rows].reverse().find((row) => row.kind === "formula" && !row.hidden && (row.format ?? "money") === "money")?.id;
  const allPositions = new Map(block.rows.map((row, index) => [row.id, index]));

  const rowAttrs = (row: ComputedRow, className: string | undefined) => ({
    className: [
      className,
      row.hidden ? ui.layoutHiddenRow : "",
      row.pageBreakAfter && !(row.kind === "group" && row.showAccounts) ? ui.pageBreakAfter : "",
      dragOver === row.id ? ui.dropTarget : "",
      dropGroup === row.id ? ui.layoutDropGroup : "",
      editor?.selectedId === row.id ? ui.layoutSelected : "",
    ]
      .filter(Boolean)
      .join(" "),
    ...(row.hidden ? { "data-export-ignore": "true" } : {}),
    ...(row.pageBreakAfter && !(row.kind === "group" && row.showAccounts) ? { "data-page-break": "after" } : {}),
    ...(editor
      ? {
          ...(editor.select
            ? {
                onClick: (event: React.MouseEvent) => {
                  if (!onControl(event.target)) editor.select!(row.id);
                },
              }
            : {}),
          onDragOver: (event: React.DragEvent) => {
            if (draggingAccounts()) {
              if (row.kind === "group") accountDrop(row.id).onDragOver?.(event);
              return;
            }
            event.preventDefault();
            setDragOver(row.id);
          },
          onDragLeave: () => {
            setDragOver(null);
            if (row.kind === "group") accountDrop(row.id).onDragLeave?.();
          },
          onDrop: (event: React.DragEvent) => {
            if (draggingAccounts()) {
              if (row.kind === "group") accountDrop(row.id).onDrop?.(event);
              return;
            }
            event.preventDefault();
            setDragOver(null);
            const moved = event.dataTransfer.getData("text/plain");
            if (moved && moved !== row.id) editor.move(moved, allPositions.get(row.id) ?? 0);
          },
        }
      : {}),
  });

  const tools = (row: ComputedRow): ReactNode =>
    editor ? (
      <td className={ui.num} data-export-ignore data-print="hide">
        <MoreMenu label={`More for ${row.label}`} items={editor.rowMenu(row)} />
      </td>
    ) : null;
  const toolsBlank = editor ? <td data-export-ignore data-print="hide" /> : null;
  const name = (row: ComputedRow) => <RowName key={`${row.id}:${row.label}`} row={row} editor={editor} position={allPositions.get(row.id) ?? 0} count={block.rows.length} />;
  const note = (row: ComputedRow) =>
    row.note && !row.hidden ? (
      <tr className={ui.layoutNoteRow}>
        <td colSpan={span}>{row.note}</td>
      </tr>
    ) : null;

  return (
    <div className={ui.statementWrap}>
      <table id={id} className={`${ui.table} ${ui.statement} ${columns.length > 2 ? ui.statementWide : ""}`}>
        <thead>
          <tr>
            <th>
              <span className={ui.srOnly}>Row</span>
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`${ui.num} ${editor?.selectColumns ? ui.layoutPickable : ""}`}
                onClick={editor?.selectColumns ? () => editor.selectColumns!() : undefined}
                title={editor?.selectColumns ? "Change the columns" : undefined}
              >
                {column.label}
              </th>
            ))}
            {editor ? (
              <th data-export-ignore data-print="hide">
                <span className={ui.srOnly}>Row actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={span} className={ui.muted}>
                No rows yet.
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            if (row.kind === "heading") {
              return (
                <Fragment key={row.id}>
                  <tr {...rowAttrs(row, ui.reportHeading)}>
                    <td colSpan={columns.length + 1}>{name(row)}</td>
                    {tools(row)}
                  </tr>
                  {note(row)}
                </Fragment>
              );
            }
            if (row.kind === "group" && row.showAccounts) {
              const picked = selected?.rowId === row.id ? selected.codes : [];
              return (
                <Fragment key={row.id}>
                  <tr {...rowAttrs({ ...row, pageBreakAfter: false }, ui.reportHeading)}>
                    <td colSpan={columns.length + 1}>{name(row)}</td>
                    {tools(row)}
                  </tr>
                  {linesOf(row).map((line) => (
                    <tr
                      key={line.code}
                      className={`${ui.reportSection} ${row.hidden ? ui.layoutHiddenRow : ""} ${line.empty ? ui.layoutEmptyLine : ""} ${dropGroup === row.id ? ui.layoutDropGroup : ""} ${canMoveAccounts ? ui.layoutDragLine : ""}`}
                      {...(row.hidden || line.empty ? { "data-export-ignore": "true" } : {})}
                      {...(line.empty ? { "data-print": "hide" } : {})}
                      {...accountDrop(row.id)}
                      {...(canMoveAccounts
                        ? {
                            draggable: !editor!.busy,
                            title: "Drag to another group to move it there",
                            onDragStart: (event: React.DragEvent) => startAccountDrag(event, row.id, line.code, line.name, picked),
                            onDragEnd: endAccountDrag,
                          }
                        : {})}
                    >
                      <td>
                        {editor ? (
                          <label className={ui.layoutPick} data-export-ignore>
                            {canMoveAccounts ? (
                              <span
                                className={ui.layoutLineGrip}
                                aria-hidden="true"
                                draggable={!editor.busy}
                                onDragStart={(event) => {
                                  // The grip drags the same way the row does; stop the row starting a second drag.
                                  event.stopPropagation();
                                  startAccountDrag(event, row.id, line.code, line.name, picked);
                                }}
                                onDragEnd={endAccountDrag}
                              >
                                ⠿
                              </span>
                            ) : null}
                            <input
                              type="checkbox"
                              checked={picked.includes(line.code)}
                              aria-label={`Choose ${line.code} ${line.name} to move or group`}
                              onChange={(event) =>
                                setSelected({
                                  rowId: row.id,
                                  codes: event.target.checked ? [...picked, line.code] : picked.filter((code) => code !== line.code),
                                })
                              }
                            />
                          </label>
                        ) : null}
                        <span title={line.empty ? `${line.code}: nothing in these dates, so it isn't on the report` : line.code}>{line.name}</span>
                      </td>
                      {columns.map((column) => (
                        <Cell key={column.key} column={column} values={line.values} accounts={{ accountId: line.accountId }} filter={filter} blankZero />
                      ))}
                      {toolsBlank}
                    </tr>
                  ))}
                  {editor && picked.length > 0 ? (
                    <tr data-export-ignore="true" data-print="hide">
                      <td colSpan={span}>
                        <span className={ui.layoutGroupBar}>
                          {canMoveAccounts ? (
                            <>
                              <select aria-label="Move the chosen accounts to" value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
                                <option value="">Move to…</option>
                                {groups
                                  .filter((group) => group.id !== row.id)
                                  .map((group) => (
                                    <option key={group.id} value={group.id}>
                                      {group.label}
                                    </option>
                                  ))}
                              </select>
                              <button
                                type="button"
                                className={`${ui.button} ${ui.secondary}`}
                                disabled={!moveTo || editor.busy}
                                onClick={() => {
                                  editor.moveAccounts!(row.id, picked, moveTo);
                                  setSelected(null);
                                  setMoveTo("");
                                }}
                              >
                                Move {picked.length} {picked.length === 1 ? "account" : "accounts"}
                              </button>
                              <span className={ui.muted}>or</span>
                            </>
                          ) : null}
                          <input
                            aria-label="Name of the new group"
                            placeholder="New group name"
                            value={groupName}
                            maxLength={200}
                            onChange={(event) => setGroupName(event.target.value)}
                          />
                          <button
                            type="button"
                            className={`${ui.button} ${ui.secondary}`}
                            disabled={!groupName.trim() || editor.busy}
                            onClick={() => {
                              editor.group(row.id, picked, groupName.trim());
                              setSelected(null);
                              setGroupName("");
                            }}
                          >
                            Group {picked.length} {picked.length === 1 ? "account" : "accounts"}
                          </button>
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  <tr {...rowAttrs(row, ui.reportTotal)}>
                    <td>Total {row.label.charAt(0).toLowerCase() + row.label.slice(1)}</td>
                    {columns.map((column) => (
                      <Cell key={column.key} column={column} values={row.values} accounts={{ accountIds: row.accountIds }} filter={filter} />
                    ))}
                    {toolsBlank}
                  </tr>
                  {note(row)}
                </Fragment>
              );
            }
            const className = row.kind === "formula" ? (row.id === lastFormula ? ui.reportGrand : ui.reportTotal) : row.kind === "earnings" ? ui.reportSection : undefined;
            return (
              <Fragment key={row.id}>
                <tr {...rowAttrs(row, className)}>
                  <td>{name(row)}</td>
                  {columns.map((column) => (
                    <Cell
                      key={column.key}
                      column={column}
                      values={row.values}
                      format={row.format}
                      accounts={row.kind === "group" ? { accountIds: row.accountIds } : undefined}
                      filter={filter}
                    />
                  ))}
                  {tools(row)}
                </tr>
                {note(row)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
