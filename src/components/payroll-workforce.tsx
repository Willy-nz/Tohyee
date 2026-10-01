"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { Budget } from "@/lib/budgets/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { EmployeeSummary } from "@/lib/payroll/employees";
import type { WorkforceBudget, WorkforceBudgetSummary, WorkforceLine, WorkforceVsActualMonth } from "@/lib/payroll/workforce-budgets";
import { WORKFORCE_LIMITS, type WorkforcePayBasis } from "@/lib/payroll/workforce-figures";

/**
 * Payroll › Workforce budget (stage P11; examples WB1-WB7): wages by
 * employee or position and month, fed into the budgets chosen as wages and
 * employer KiwiSaver by Department. Payroll access only (decision 122).
 */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

type SplitDraft = { percentage: string; departmentId: string };

type LineDraft = {
  key: string;
  employeeId: string;
  positionName: string;
  payBasis: WorkforcePayBasis;
  rate: string;
  riseMonth: string;
  riseRate: string;
  /** Rises after the first, kept as they are (edit them through the API). */
  otherRises: Array<{ fromMonth: string; rate: string }>;
  fte: string;
  hoursPerWeek: string;
  kiwiSaverRate: string;
  startMonth: string;
  endMonth: string;
  splits: SplitDraft[];
};

let draftCounter = 0;
const draftKey = () => `line-${(draftCounter += 1)}`;

function toDraft(line: WorkforceLine): LineDraft {
  const [first, rise, ...others] = line.rates;
  return {
    key: draftKey(),
    employeeId: line.employeeId ?? "",
    positionName: line.positionName ?? "",
    payBasis: line.payBasis,
    rate: first?.rate ?? "",
    riseMonth: rise?.fromMonth ?? "",
    riseRate: rise?.rate ?? "",
    otherRises: others,
    fte: line.fte ?? "1",
    hoursPerWeek: line.hoursPerWeek ?? "",
    kiwiSaverRate: line.kiwiSaverRate,
    startMonth: line.startMonth,
    endMonth: line.endMonth ?? "",
    splits: line.splits.map((split) => ({ percentage: split.percentage, departmentId: split.departmentId ?? "" })),
  };
}

function toPayload(draft: LineDraft): Record<string, unknown> {
  const rates = [{ fromMonth: draft.startMonth, rate: draft.rate }];
  if (draft.riseMonth && draft.riseRate) rates.push({ fromMonth: draft.riseMonth, rate: draft.riseRate });
  rates.push(...draft.otherRises);
  return {
    ...(draft.employeeId ? { employeeId: draft.employeeId } : { positionName: draft.positionName }),
    payBasis: draft.payBasis,
    fte: draft.payBasis === "salary" ? draft.fte : null,
    hoursPerWeek: draft.payBasis === "hourly" ? draft.hoursPerWeek : null,
    kiwiSaverRate: draft.kiwiSaverRate,
    startMonth: draft.startMonth,
    endMonth: draft.endMonth || null,
    rates,
    splits: draft.employeeId ? [] : draft.splits.map((split) => ({ percentage: split.percentage, departmentId: split.departmentId || null })),
  };
}

export function WorkforceBudgets({ organisationId }: { organisationId: string }) {
  const list = useApiData<{ workforceBudgets: WorkforceBudgetSummary[] }>("/api/payroll/workforce-budgets", { organisationId });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [firstMonth, setFirstMonth] = useState("");
  const [months, setMonths] = useState("12");
  const [createKey, setCreateKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ workforceBudget: WorkforceBudget }>("/api/payroll/workforce-budgets", {
        method: "POST",
        body: { organisationId, idempotencyKey: createKey, name, firstMonth, months: Number(months) },
      });
      setCreateKey(newIdempotencyKey());
      setName("");
      list.reload();
      setSelected(result.workforceBudget.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    return (
      <>
        <p>
          <Button variant="secondary" onClick={() => (setSelected(null), list.reload())}>
            All workforce budgets
          </Button>
        </p>
        <WorkforceBudgetEditor key={selected} organisationId={organisationId} workforceBudgetId={selected} />
      </>
    );
  }

  return (
    <>
      <Card title="Workforce budgets" description="Each feeds the budgets chosen on it with wages and employer KiwiSaver by month and Department.">
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {list.data && list.data.workforceBudgets.length === 0 ? <Empty>No workforce budgets yet.</Empty> : null}
        {list.data && list.data.workforceBudgets.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Months</th>
                  <th className={ui.num}>Lines</th>
                  <th>Feeds</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {list.data.workforceBudgets.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <Button variant="secondary" size="small" onClick={() => setSelected(entry.id)}>
                        {entry.name}
                      </Button>
                    </td>
                    <td>
                      {monthLabel(entry.firstMonth)}, {entry.months} months
                    </td>
                    <td className={ui.num}>{entry.lineCount}</td>
                    <td>{entry.budgetNames.join(", ") || <span className={ui.muted}>No budgets yet</span>}</td>
                    <td>{formatDateTime(entry.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card title="New workforce budget">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={ui.inlineForm} onSubmit={(event) => void create(event)}>
          <Field label="Name">
            <input value={name} maxLength={WORKFORCE_LIMITS.nameLength} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="First month">
            <input type="month" value={firstMonth} onChange={(event) => setFirstMonth(event.target.value)} required />
          </Field>
          <Field label="Months">
            <select value={months} onChange={(event) => setMonths(event.target.value)}>
              {[3, 6, 12, 18, 24].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>
      </Card>
    </>
  );
}

function WorkforceBudgetEditor({ organisationId, workforceBudgetId }: { organisationId: string; workforceBudgetId: string }) {
  const loaded = useApiData<{ workforceBudget: WorkforceBudget }>(`/api/payroll/workforce-budgets/${workforceBudgetId}`, { organisationId });
  const budgets = useApiData<{ budgets: Budget[] }>("/api/budgets", { organisationId });
  const employees = useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", { organisationId });
  const tracking = useTracking(organisationId);
  const vsActual = useApiData<{ months: WorkforceVsActualMonth[] }>(`/api/payroll/workforce-budgets/${workforceBudgetId}/vs-actual`, { organisationId });
  const [drafts, setDrafts] = useState<LineDraft[] | null>(null);
  const [targets, setTargets] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const wb = loaded.data?.workforceBudget;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!wb) return <Empty>Loading…</Empty>;
  const lines = drafts ?? wb.lines.map(toDraft);
  const chosen = targets ?? wb.targets.map((target) => target.budgetId);
  const departments = tracking.data?.categories.find((category) => category.kind === "department")?.values ?? [];

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      setDrafts(null);
      setTargets(null);
      loaded.reload();
      vsActual.reload();
      setMessage({ tone: "success", text });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const change = (index: number, patch: Partial<LineDraft>) => setDrafts(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  const saveLines = () =>
    run(async () => {
      await api(`/api/payroll/workforce-budgets/${wb.id}/lines`, { method: "PUT", body: { organisationId, version: wb.version, lines: lines.map(toPayload) } });
      return "Saved, and the budgets it feeds were updated.";
    });
  const saveTargets = () =>
    run(async () => {
      await api(`/api/payroll/workforce-budgets/${wb.id}`, { method: "PUT", body: { organisationId, version: wb.version, budgetIds: chosen } });
      return "Saved the budgets it feeds.";
    });
  const updateBudgets = () =>
    run(async () => {
      const result = await api<{ changed: number }>(`/api/payroll/workforce-budgets/${wb.id}/update-budgets`, { method: "POST", body: { organisationId } });
      return result.changed === 1 ? "Updated 1 amount." : `Updated ${result.changed} amounts.`;
    });
  const addEmployee = (employeeId: string) => {
    const employee = employees.data?.employees.find((entry) => entry.id === employeeId);
    if (!employee) return;
    // Pay, KiwiSaver and months come from the employee's records when saved (decision 116).
    setDrafts([
      ...lines,
      {
        key: draftKey(),
        employeeId,
        positionName: "",
        payBasis: employee.payBasis,
        rate: (employee.payBasis === "salary" ? employee.annualSalary : employee.hourlyRate) ?? "",
        riseMonth: "",
        riseRate: "",
        otherRises: [],
        fte: "1",
        hoursPerWeek: employee.ordinaryHoursPerWeek ?? "",
        kiwiSaverRate: employee.kiwiSaverStatus === "enrolled" ? employee.kiwiSaverEmployerRate : "0",
        startMonth: wb.months[0] < employee.startDate.slice(0, 7) ? employee.startDate.slice(0, 7) : wb.months[0],
        endMonth: "",
        splits: [],
      },
    ]);
  };
  const addPosition = () =>
    setDrafts([
      ...lines,
      {
        key: draftKey(),
        employeeId: "",
        positionName: "",
        payBasis: "salary",
        rate: "",
        riseMonth: "",
        riseRate: "",
        otherRises: [],
        fte: "1",
        hoursPerWeek: "",
        kiwiSaverRate: "3.5",
        startMonth: wb.months[0],
        endMonth: "",
        splits: [{ percentage: "100", departmentId: "" }],
      },
    ]);
  const lineNames = new Map(wb.lines.map((line) => [line.employeeId ?? line.positionName ?? "", line.employeeName ?? line.positionName ?? ""]));
  const unused = (employees.data?.employees ?? []).filter((employee) => !employee.isArchived && !lines.some((line) => line.employeeId === employee.id));

  return (
    <>
      <Card
        title={wb.name}
        description={`${monthLabel(wb.months[0])} to ${monthLabel(wb.months[wb.months.length - 1])}. Wages to ${wb.wagesAccount.code} ${wb.wagesAccount.name}, employer KiwiSaver to ${wb.kiwiSaverAccount.code} ${wb.kiwiSaverAccount.name}. Changed ${formatDateTime(wb.updatedAt)} by ${wb.updatedByEmail}.`}
      >
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <h3>Budgets it feeds</h3>
        <p className={ui.muted}>
          In each, the workforce budget writes the wages and KiwiSaver accounts for all its months; those amounts can&apos;t be typed there. A budget for a
          Department gets only that Department&apos;s share. Taking a budget off leaves its amounts as typed amounts.
        </p>
        <div className={ui.inlineForm}>
          {(budgets.data?.budgets ?? []).map((budget) => (
            <label key={budget.id}>
              <input
                type="checkbox"
                checked={chosen.includes(budget.id)}
                onChange={(event) => setTargets(event.target.checked ? [...chosen, budget.id] : chosen.filter((id) => id !== budget.id))}
              />{" "}
              {budget.name}
              {budget.trackingLabel ? ` (${budget.trackingLabel})` : ""}{" "}
              {wb.targets.find((target) => target.budgetId === budget.id)?.upToDate === false ? <Badge tone="amber">Out of date</Badge> : null}
            </label>
          ))}
          <Button variant="secondary" disabled={busy || targets === null} onClick={() => void saveTargets()}>
            Save budgets
          </Button>
          <Button variant="secondary" disabled={busy || wb.targets.length === 0} onClick={() => void updateBudgets()}>
            Update budgets
          </Button>
        </div>
      </Card>

      <Card title="Lines" description="An employee's split is their cost allocation on the 1st of each month; a position has its own split. Whole months only.">
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Employee or position</th>
                <th>Pay</th>
                <th className={ui.num}>Annual salary or hourly rate</th>
                <th className={ui.num}>FTE or hours a week</th>
                <th>Pay rise from</th>
                <th className={ui.num}>KiwiSaver %</th>
                <th>Start</th>
                <th>End</th>
                <th>Split (positions)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td>
                    {line.employeeId ? (
                      (lineNames.get(line.employeeId) ?? employees.data?.employees.find((entry) => entry.id === line.employeeId)?.firstName ?? "Employee")
                    ) : (
                      <input aria-label="Position" value={line.positionName} placeholder="Position" onChange={(event) => change(index, { positionName: event.target.value })} />
                    )}
                  </td>
                  <td>
                    <select value={line.payBasis} onChange={(event) => change(index, { payBasis: event.target.value as WorkforcePayBasis })}>
                      <option value="salary">Salary</option>
                      <option value="hourly">Hourly</option>
                    </select>
                  </td>
                  <td className={ui.num}>
                    <input aria-label="Rate" inputMode="decimal" size={9} value={line.rate} onChange={(event) => change(index, { rate: event.target.value })} />
                  </td>
                  <td className={ui.num}>
                    {line.payBasis === "salary" ? (
                      <input aria-label="FTE" inputMode="decimal" size={5} value={line.fte} onChange={(event) => change(index, { fte: event.target.value })} />
                    ) : (
                      <input aria-label="Hours a week" inputMode="decimal" size={5} value={line.hoursPerWeek} onChange={(event) => change(index, { hoursPerWeek: event.target.value })} />
                    )}
                  </td>
                  <td>
                    <input aria-label="Pay rise month" type="month" value={line.riseMonth} onChange={(event) => change(index, { riseMonth: event.target.value })} />{" "}
                    <input aria-label="New rate" inputMode="decimal" size={9} value={line.riseRate} placeholder="New rate" onChange={(event) => change(index, { riseRate: event.target.value })} />
                    {line.otherRises.length > 0 ? <span className={ui.muted}> and {line.otherRises.length} more</span> : null}
                  </td>
                  <td className={ui.num}>
                    <input aria-label="KiwiSaver rate" inputMode="decimal" size={4} value={line.kiwiSaverRate} onChange={(event) => change(index, { kiwiSaverRate: event.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Start month" type="month" value={line.startMonth} onChange={(event) => change(index, { startMonth: event.target.value })} />
                  </td>
                  <td>
                    <input aria-label="End month" type="month" value={line.endMonth} onChange={(event) => change(index, { endMonth: event.target.value })} />
                  </td>
                  <td>
                    {line.employeeId ? (
                      <span className={ui.muted}>Cost allocation</span>
                    ) : (
                      <>
                        {line.splits.map((split, splitIndex) => (
                          <div key={splitIndex}>
                            <input
                              aria-label="Split %"
                              inputMode="decimal"
                              size={4}
                              value={split.percentage}
                              onChange={(event) => change(index, { splits: line.splits.map((entry, at) => (at === splitIndex ? { ...entry, percentage: event.target.value } : entry)) })}
                            />
                            %{" "}
                            <select
                              aria-label="Department"
                              value={split.departmentId}
                              onChange={(event) => change(index, { splits: line.splits.map((entry, at) => (at === splitIndex ? { ...entry, departmentId: event.target.value } : entry)) })}
                            >
                              <option value="">No Department</option>
                              {departments.map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                        <Button variant="secondary" size="small" onClick={() => change(index, { splits: [...line.splits, { percentage: "", departmentId: "" }] })}>
                          Add split
                        </Button>
                      </>
                    )}
                  </td>
                  <td>
                    <Button variant="secondary" size="small" onClick={() => setDrafts(lines.filter((_, at) => at !== index))}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={ui.actions}>
          <select aria-label="Add an employee" value="" onChange={(event) => addEmployee(event.target.value)}>
            <option value="">Add an employee…</option>
            {unused.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.firstName} {employee.lastName}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={addPosition}>
            Add a position
          </Button>
          <Button disabled={busy || drafts === null} onClick={() => void saveLines()}>
            {busy ? "Saving…" : "Save lines"}
          </Button>
          {drafts !== null ? (
            <Button variant="secondary" onClick={() => setDrafts(null)}>
              Undo changes
            </Button>
          ) : null}
        </div>
      </Card>

      <Card title="Wages and KiwiSaver by month" description="Each line's month rounded once to the cent; KiwiSaver truncated as pay runs do; Departments add up to the total.">
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th />
                {wb.months.map((month) => (
                  <th key={month} className={ui.num}>
                    {monthLabel(month)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wb.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.employeeName ?? line.positionName}</td>
                  {line.figures.map((month) => (
                    <td key={month.month} className={ui.num}>
                      <Money value={month.wages} blankZero />
                      {month.kiwiSaver !== "0.00" ? (
                        <div className={ui.muted}>
                          + <Money value={month.kiwiSaver} />
                        </div>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
              {wb.departments.map((row) => (
                <tr key={row.departmentId ?? "none"}>
                  <th>{row.label}</th>
                  {wb.months.map((month, index) => (
                    <td key={month} className={ui.num}>
                      <Money value={row.wages[index]} blankZero />
                      <div className={ui.muted}>
                        + <Money value={row.kiwiSaver[index]} />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total wages + KiwiSaver ({<Money value={wb.totals.total} />} in all)</td>
                {wb.months.map((month, index) => (
                  <td key={month} className={ui.num}>
                    <Money value={wb.totals.wages[index]} />
                    <div className={ui.muted}>
                      + <Money value={wb.totals.kiwiSaver[index]} />
                    </div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card title="Budget vs actual for wages" description="Wages and KiwiSaver budgeted against labour cost from approved pay runs by pay date (Payroll › Reports). Variance is actual less budget.">
        {vsActual.error ? <Notice tone="error">{vsActual.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Month</th>
                <th>Department</th>
                <th className={ui.num}>Budget</th>
                <th className={ui.num}>Actual</th>
                <th className={ui.num}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {(vsActual.data?.months ?? []).flatMap((month) => [
                ...month.rows.map((row) => (
                  <tr key={`${month.month}-${row.departmentId ?? "none"}`}>
                    <td>{monthLabel(month.month)}</td>
                    <td>{row.label}</td>
                    <td className={ui.num}>
                      <Money value={row.budget} />
                    </td>
                    <td className={ui.num}>
                      <Money value={row.actual} />
                    </td>
                    <td className={ui.num}>
                      <Money value={row.variance} />
                    </td>
                  </tr>
                )),
                <tr key={`${month.month}-total`}>
                  <th>{monthLabel(month.month)}</th>
                  <th>Total</th>
                  <th className={ui.num}>
                    <Money value={month.total.budget} />
                  </th>
                  <th className={ui.num}>
                    <Money value={month.total.actual} />
                  </th>
                  <th className={ui.num}>
                    <Money value={month.total.variance} />
                  </th>
                </tr>,
              ])}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
