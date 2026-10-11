"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import { classesOf, KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";
import type { AgeingPreview, HeadCount, LivestockLocation, LivestockOpening, LivestockSettings, Movement, MovementType } from "@/lib/livestock/movements";
import type { Election, Rate, ValuationPreview } from "@/lib/livestock/valuation";

/*
 * Accounting › Livestock (#221; examples LV1-LV12): movements and head
 * counts, then the year-end valuation, then review and post. Shared types
 * only: the work is done on the server.
 */

const MOVEMENT_LABELS: Record<MovementType, string> = {
  birth: "Born",
  purchase: "Bought",
  sale: "Sold",
  death: "Died",
  missing: "Missing",
  found: "Found",
  reclass: "Class change",
  transfer: "Moved",
  arrival: "Arrived (someone else's)",
  departure: "Left (someone else's)",
};

const MOVEMENT_ORDER: MovementType[] = ["birth", "purchase", "sale", "death", "missing", "found", "reclass", "transfer", "arrival", "departure"];

/** Year ends from the first year to the one containing today. */
function yearEnds(settings: LivestockSettings): string[] {
  if (!settings.firstYearStart) return [];
  const result: string[] = [];
  const month = settings.financialYearEndMonth;
  const endOf = (year: number) => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  };
  const firstEndYear = Number(settings.firstYearStart.slice(0, 4)) + (month === 12 ? 0 : 1);
  const today = todayInBrowser();
  for (let year = firstEndYear; year < firstEndYear + 50; year += 1) {
    const end = endOf(year);
    result.push(end);
    if (end >= today) break;
  }
  return result.reverse();
}

/** The latest year that has ended (the one usually being worked on), or the first year. */
function defaultYear(years: string[]): string {
  const today = todayInBrowser();
  return years.find((year) => year < today) ?? years[years.length - 1];
}

function useLivestockSettings(organisationId: string) {
  return useApiData<{ settings: LivestockSettings }>("/api/livestock/settings", { organisationId });
}

function NotOn({ canSetUp }: { canSetUp: boolean }) {
  return (
    <Card title="Livestock isn't turned on">
      <p>
        Livestock records a farm&apos;s dairy cattle, beef cattle and sheep, reconciles head counts by class and values them at year end under the herd scheme or national
        standard cost.
      </p>
      {canSetUp ? (
        <Link className={`${ui.button} ${ui.primary}`} href="/operations/livestock/settings">
          Set up livestock
        </Link>
      ) : (
        <p className={ui.muted}>An admin can turn it on.</p>
      )}
    </Card>
  );
}

function YearPicker({ years, value, onChange }: { years: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Year ending">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {years.map((year) => (
          <option key={year} value={year}>
            {formatDate(year)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Steps({ current }: { current: "movements" | "valuation" | "overview" }) {
  const steps = [
    { key: "movements", href: "/operations/livestock/movements", label: "1. Movements", text: "Births, purchases, sales, deaths and moves" },
    { key: "overview", href: "/operations/livestock", label: "2. Head count", text: "Reconcile by class; enter the year-end count" },
    { key: "valuation", href: "/operations/livestock/valuation", label: "3. Value, review and post", text: "Workings, trading statement and the journal" },
  ];
  return (
    <nav className={ui.tabs} aria-label="Livestock steps">
      {steps.map((step) => (
        <Link key={step.key} href={step.href} className={`${ui.tab} ${current === step.key ? ui.tabActive : ""}`} title={step.text} aria-current={current === step.key ? "page" : undefined}>
          {step.label}
        </Link>
      ))}
    </nav>
  );
}

// Overview: head count -----------------------------------------------------------

export function LivestockOverview({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useLivestockSettings(organisationId);
  const [chosen, setChosen] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;
  const years = yearEnds(settings.data.settings);
  const yearEnd = chosen ?? defaultYear(years);
  return (
    <>
      <Steps current="overview" />
      <div className={ui.toolbar}>
        <YearPicker years={years} value={yearEnd} onChange={setChosen} />
      </div>
      <HeadCountView key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} />
    </>
  );
}

function HeadCountView({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const { can } = useWorkspace();
  const result = useApiData<{ headCount: HeadCount }>("/api/livestock/head-count", { organisationId, yearEnd });
  const ageing = useApiData<{ ageing: AgeingPreview }>("/api/livestock/ageing", { organisationId, yearEnd });
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [split, setSplit] = useState("");
  const [busy, setBusy] = useState(false);
  if (result.error) return <Notice tone="error">{result.error}</Notice>;
  if (!result.data) return <p className={ui.muted}>Loading…</p>;
  const data = result.data.headCount;

  async function saveCounts() {
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(counts)
        .filter(([, head]) => head.trim() !== "")
        .map(([key, head]) => {
          const [kind, classCode] = key.split(".");
          return { kind, classCode, head };
        });
      await api("/api/livestock/counts", { method: "POST", body: { organisationId, countDate: yearEnd, lines } });
      setCounts({});
      result.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSplit(kind: string, classCode: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/ageing", { method: "PUT", body: { organisationId, yearEnd, kind, classCode, head: split } });
      setSplit("");
      result.reload();
      ageing.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const kinds = LIVESTOCK_KINDS.filter((kind) => data.rows.some((row) => row.kind === kind));
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data.unexplained.length > 0 ? (
        <Notice tone="warning">
          {data.unexplained.map((entry) => `${entry.className}: ${entry.counted} counted, ${entry.expected} expected (${Math.abs(entry.difference)} not explained).`).join(" ")} Record
          the missing, found or other movements that explain the difference; the year can&apos;t be valued until then.
        </Notice>
      ) : null}
      <div className={ui.statRow}>
        <Stat label="Opening head" value={data.totals.opening.toLocaleString("en-NZ")} />
        <Stat label="Born" value={data.totals.births.toLocaleString("en-NZ")} />
        <Stat label="Bought" value={data.totals.bought.toLocaleString("en-NZ")} />
        <Stat label="Sold" value={data.totals.sold.toLocaleString("en-NZ")} />
        <Stat label="Closing head" value={data.totals.closing.toLocaleString("en-NZ")} />
      </div>
      <Card
        title={`Head count, ${formatDate(data.yearStart)} to ${formatDate(data.yearEnd)}`}
        description="Opening + born + bought − sold − died − missing + found ± class changes ± ageing = closing. Ageing happens at the start of the year and nets to zero across the herd."
      >
        {data.rows.length === 0 ? (
          <Empty>No stock yet. Set the opening position in Livestock settings, then record movements.</Empty>
        ) : (
          kinds.map((kind) => (
            <div key={kind} className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <caption>{KIND_NAMES[kind]}</caption>
                <thead>
                  <tr>
                    <th>Class</th>
                    <th className={ui.num}>Opening</th>
                    <th className={ui.num}>Ageing</th>
                    <th className={ui.num}>Born</th>
                    <th className={ui.num}>Bought</th>
                    <th className={ui.num}>Sold</th>
                    <th className={ui.num}>Died</th>
                    <th className={ui.num}>Missing / found</th>
                    <th className={ui.num}>Class changes</th>
                    <th className={ui.num}>Closing</th>
                    <th className={ui.num}>Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows
                    .filter((row) => row.kind === kind)
                    .map((row) => {
                      const key = `${row.kind}.${row.classCode}`;
                      const signed = (value: number) => (value === 0 ? "" : value > 0 ? `+${value}` : String(value));
                      return (
                        <tr key={key}>
                          <td data-label="Class">{row.className}</td>
                          <td data-label="Opening" className={ui.num}>
                            {row.opening}
                          </td>
                          <td data-label="Ageing" className={ui.num}>
                            {signed(row.ageingIn - row.ageingOut)}
                          </td>
                          <td data-label="Born" className={ui.num}>
                            {row.births || ""}
                          </td>
                          <td data-label="Bought" className={ui.num}>
                            {row.bought || ""}
                          </td>
                          <td data-label="Sold" className={ui.num}>
                            {row.sold ? `(${row.sold})` : ""}
                          </td>
                          <td data-label="Died" className={ui.num}>
                            {row.died ? `(${row.died})` : ""}
                          </td>
                          <td data-label="Missing / found" className={ui.num}>
                            {signed(row.found - row.missing)}
                          </td>
                          <td data-label="Class changes" className={ui.num}>
                            {signed(row.reclassIn - row.reclassOut)}
                          </td>
                          <td data-label="Closing" className={ui.num}>
                            <strong>{row.closing}</strong>
                          </td>
                          <td data-label="Counted" className={ui.num}>
                            {can("bookkeeper") ? (
                              <input
                                aria-label={`${row.className} counted`}
                                inputMode="numeric"
                                size={6}
                                placeholder={row.counted === null ? "" : String(row.counted)}
                                value={counts[key] ?? ""}
                                onChange={(event) => setCounts({ ...counts, [key]: event.target.value })}
                              />
                            ) : (
                              (row.counted ?? "")
                            )}
                            {row.unexplained ? <Badge tone="amber">{row.unexplained > 0 ? `${row.unexplained} short` : `${-row.unexplained} over`}</Badge> : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))
        )}
        <p className={ui.muted}>
          Totals: opening {data.totals.opening}, closing {data.totals.closing}. Ageing {data.ageingBalances ? "nets to zero" : "doesn't net to zero"}.
        </p>
        {can("bookkeeper") && Object.values(counts).some((value) => value.trim() !== "") ? (
          <Button disabled={busy} onClick={() => void saveCounts()}>
            Save year-end count
          </Button>
        ) : null}
      </Card>

      <Card title="Ageing at the start of the year" description="Each class's head at the end of last year moves to the next class. It's worked out, so it can't run twice, and a late entry in an earlier year flows through.">
        {ageing.data ? (
          <>
            {ageing.data.ageing.steps.length === 0 && ageing.data.ageing.needsSplit.length === 0 ? <Empty>Nothing to age.</Empty> : null}
            <ul>
              {ageing.data.ageing.steps.map((step) => (
                <li key={`${step.kind}.${step.classCode}`}>
                  {KIND_NAMES[step.kind]}: {step.head} {step.className.toLowerCase()} → {step.toClassName.toLowerCase()}
                </li>
              ))}
            </ul>
            {ageing.data.ageing.needsSplit.map((step) => (
              <div key={step.classCode} className={ui.inlineForm}>
                <Field label={`How many of the ${step.head} ${step.className.toLowerCase()} turned rising five?`}>
                  <input inputMode="numeric" value={split} onChange={(event) => setSplit(event.target.value)} />
                </Field>
                {can("bookkeeper") ? (
                  <Button disabled={busy || split.trim() === ""} onClick={() => void saveSplit(step.kind, step.classCode)}>
                    Save
                  </Button>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </Card>

      {data.held.length > 0 ? (
        <Card title="Held for others" description="Stock on the farm that belongs to someone else. Shown here, never counted as the farm's or valued (LV3).">
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Whose</th>
                  <th>Class</th>
                  <th className={ui.num}>Opening</th>
                  <th className={ui.num}>Arrived</th>
                  <th className={ui.num}>Left</th>
                  <th className={ui.num}>Closing</th>
                </tr>
              </thead>
              <tbody>
                {data.held.map((row) => (
                  <tr key={`${row.heldFor}.${row.kind}.${row.classCode}`}>
                    <td data-label="Whose">{row.heldFor}</td>
                    <td data-label="Class">
                      {KIND_NAMES[row.kind]}: {row.className}
                    </td>
                    <td data-label="Opening" className={ui.num}>
                      {row.opening}
                    </td>
                    <td data-label="Arrived" className={ui.num}>
                      {row.arrived}
                    </td>
                    <td data-label="Left" className={ui.num}>
                      {row.left}
                    </td>
                    <td data-label="Closing" className={ui.num}>
                      {row.closing}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {data.byLocation.length > 0 ? (
        <Card title="Where the stock is" description={`At ${formatDate(data.yearEnd)}, by kind. The farm's own stock grazing elsewhere is still counted.`}>
          <ul>
            {data.byLocation.map((row) => (
              <li key={`${row.locationId ?? "none"}.${row.kind}`}>
                {row.locationName}: {row.head} {KIND_NAMES[row.kind].toLowerCase()}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

// Movements ------------------------------------------------------------------------

export function LivestockMovements({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const settings = useLivestockSettings(organisationId);
  const movements = useApiData<{ movements: Movement[] }>("/api/livestock/movements", { organisationId, includeVoided: "true" });
  const locations = useApiData<{ locations: LivestockLocation[] }>("/api/livestock/locations", { organisationId });
  const [form, setForm] = useState({
    movementType: "birth" as MovementType,
    movementDate: todayInBrowser(),
    kind: "dairy_cattle" as LivestockKind,
    classCode: "r1_heifers",
    toClassCode: "",
    head: "",
    amount: "",
    heldFor: "",
    locationId: "",
    toLocationId: "",
    note: "",
  });
  const [key, setKey] = useState(() => newIdempotencyKey("lv"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;
  const classes = classesOf(form.kind);
  const activeLocations = (locations.data?.locations ?? []).filter((location) => !location.archived);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        organisationId,
        source: "ui",
        idempotencyKey: key,
        movementType: form.movementType,
        movementDate: form.movementDate,
        kind: form.kind,
        classCode: form.classCode,
        head: form.head,
        note: form.note || null,
        locationId: form.locationId || null,
      };
      if (form.movementType === "reclass") body.toClassCode = form.toClassCode;
      if (form.movementType === "transfer") body.toLocationId = form.toLocationId;
      if (form.movementType === "purchase" || form.movementType === "sale") body.amount = form.amount || null;
      if (form.movementType === "arrival" || form.movementType === "departure") body.heldFor = form.heldFor;
      await api("/api/livestock/movements", { method: "POST", body });
      setMessage(`Recorded: ${MOVEMENT_LABELS[form.movementType].toLowerCase()}, ${form.head} ${classes.find((entry) => entry.code === form.classCode)?.name.toLowerCase()}.`);
      setKey(newIdempotencyKey("lv"));
      setForm({ ...form, head: "", amount: "", note: "" });
      movements.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function voidOne(movement: Movement) {
    const ok = await confirm(`Void this movement (${MOVEMENT_LABELS[movement.movementType].toLowerCase()}, ${movement.head} ${movement.className.toLowerCase()} on ${formatDate(movement.movementDate)})?`, {
      confirmLabel: "Void",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/livestock/movements/${movement.id}/void`, { method: "POST", body: { organisationId, reason: "Voided in Livestock › Movements" } });
      movements.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <Steps current="movements" />
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {can("bookkeeper") ? (
        <Card title="Record a movement" description="Births go into the rising one-year classes. Classes are what each animal will be at balance date. Nothing posts: values come from the year-end valuation.">
          <div className={ui.grid}>
            <Field label="What happened">
              <select value={form.movementType} onChange={(event) => setForm({ ...form, movementType: event.target.value as MovementType })}>
                {MOVEMENT_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {MOVEMENT_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={form.movementDate} onChange={(event) => setForm({ ...form, movementDate: event.target.value })} />
            </Field>
            <Field label="Livestock">
              <select
                value={form.kind}
                onChange={(event) => {
                  const kind = event.target.value as LivestockKind;
                  setForm({ ...form, kind, classCode: classesOf(kind)[0].code, toClassCode: "" });
                }}
              >
                {LIVESTOCK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_NAMES[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={form.movementType === "reclass" ? "From class" : "Class"}>
              <select value={form.classCode} onChange={(event) => setForm({ ...form, classCode: event.target.value })}>
                {classes
                  .filter((entry) => form.movementType !== "birth" || entry.birth)
                  .map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </Field>
            {form.movementType === "reclass" ? (
              <Field label="To class">
                <select value={form.toClassCode} onChange={(event) => setForm({ ...form, toClassCode: event.target.value })}>
                  <option value="">Choose…</option>
                  {classes
                    .filter((entry) => entry.code !== form.classCode)
                    .map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.name}
                      </option>
                    ))}
                </select>
              </Field>
            ) : null}
            <Field label="Head">
              <input inputMode="numeric" value={form.head} onChange={(event) => setForm({ ...form, head: event.target.value })} />
            </Field>
            {form.movementType === "purchase" || form.movementType === "sale" ? (
              <Field label="Amount excl. GST" hint="Needed for the trading statement, unless the invoice or bill line is linked.">
                <input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
              </Field>
            ) : null}
            {form.movementType === "arrival" || form.movementType === "departure" ? (
              <Field label="Whose stock">
                <input value={form.heldFor} onChange={(event) => setForm({ ...form, heldFor: event.target.value })} />
              </Field>
            ) : null}
            {activeLocations.length > 0 ? (
              <Field label={form.movementType === "transfer" ? "From location" : "Location"}>
                <select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
                  <option value="">No location</option>
                  {activeLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {form.movementType === "transfer" ? (
              <Field label="To location" hint={activeLocations.length === 0 ? "Add locations in Livestock settings first." : undefined}>
                <select value={form.toLocationId} onChange={(event) => setForm({ ...form, toLocationId: event.target.value })}>
                  <option value="">Choose…</option>
                  {activeLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Note">
              <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </Field>
          </div>
          <Button disabled={busy || form.head.trim() === ""} onClick={() => void save()}>
            Record
          </Button>
        </Card>
      ) : null}

      <Card title="Movements" description="Newest first. Voided movements stay, marked voided.">
        {movements.error ? <Notice tone="error">{movements.error}</Notice> : null}
        {movements.data && movements.data.movements.length === 0 ? <Empty>No movements yet.</Empty> : null}
        {movements.data && movements.data.movements.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Class</th>
                  <th className={ui.num}>Head</th>
                  <th className={ui.num}>Amount</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {movements.data.movements.map((movement) => (
                  <tr key={movement.id}>
                    <td data-label="Date">{formatDate(movement.movementDate)}</td>
                    <td data-label="What">
                      {MOVEMENT_LABELS[movement.movementType]} {movement.voided ? <Badge tone="red">Voided</Badge> : null}
                    </td>
                    <td data-label="Class">
                      {KIND_NAMES[movement.kind]}: {movement.className}
                      {movement.toClassCode ? ` → ${classesOf(movement.kind).find((entry) => entry.code === movement.toClassCode)?.name ?? movement.toClassCode}` : ""}
                    </td>
                    <td data-label="Head" className={ui.num}>
                      {movement.head}
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      {movement.amount ? <Money value={movement.amount} /> : null}
                    </td>
                    <td data-label="Details">
                      {[
                        movement.heldFor ? `For ${movement.heldFor}` : null,
                        movement.locationName,
                        movement.toLocationName ? `to ${movement.toLocationName}` : null,
                        movement.invoiceNumber ? `Invoice ${movement.invoiceNumber}` : null,
                        movement.billReference ? `Bill ${movement.billReference}` : null,
                        movement.note,
                        movement.voidReason ? `Voided: ${movement.voidReason}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                    <td>
                      {can("bookkeeper") && !movement.voided ? (
                        <Button variant="secondary" size="small" onClick={() => void voidOne(movement)}>
                          Void
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

// Valuation ------------------------------------------------------------------------

export function LivestockValuation({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useLivestockSettings(organisationId);
  const [chosen, setChosen] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;
  const years = yearEnds(settings.data.settings);
  const yearEnd = chosen ?? defaultYear(years);
  return (
    <>
      <Steps current="valuation" />
      <div className={ui.toolbar}>
        <YearPicker years={years} value={yearEnd} onChange={setChosen} />
      </div>
      <ValuationView key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} />
    </>
  );
}

function ValuationView({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const preview = useApiData<{ valuation: ValuationPreview }>("/api/livestock/valuation", { organisationId, yearEnd });
  const [key, setKey] = useState(() => newIdempotencyKey("lvv"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (preview.error) return <Notice tone="error">{preview.error}</Notice>;
  if (!preview.data) return <p className={ui.muted}>Loading…</p>;
  const { workings, journal, problems, approved, revaluationTarget } = preview.data.valuation;
  const totals = workings.totals;

  async function approve() {
    const ok = await confirm(`Approve the livestock valuation for the year to ${formatDate(yearEnd)} and post its journal?`, { confirmLabel: "Approve and post" });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/valuation", { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, yearEnd } });
      setKey(newIdempotencyKey("lvv"));
      preview.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function replace() {
    const ok = await confirm("Replace this valuation? Its journal is reversed, and the year can be changed and approved again.", { confirmLabel: "Replace", danger: true });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/valuation/replace", { method: "POST", body: { organisationId, yearEnd, reason } });
      setReason("");
      preview.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {approved ? (
        <Notice tone="success">
          Approved by {approved.approvedByEmail} on {formatDate(approved.approvedAt.slice(0, 10))}.{" "}
          {approved.journalId ? <Link href={`/operations/ledger-journals?journalId=${approved.journalId}`}>See the journal</Link> : null}
        </Notice>
      ) : problems.length > 0 ? (
        <Notice tone="warning">
          <strong>Not ready to approve:</strong>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className={ui.statRow}>
        <Stat label="Opening value" value={<Money value={totals.openingValue} />} />
        <Stat label="Closing value" value={<Money value={totals.closingValue} />} />
        <Stat label="Taxable livestock profit" value={<Money value={totals.taxableProfit} />} />
        <Stat label="Herd scheme revaluation (non-taxable)" value={<Money value={totals.revaluation} />} />
      </div>
      <Card title="Livestock trading statement" description={`${formatDate(workings.yearStart)} to ${formatDate(workings.yearEnd)}, the ${workings.incomeYear - 1}-${String(workings.incomeYear).slice(2)} income year.`}>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>Sales</td>
                <td className={ui.num}>
                  <Money value={totals.sales} />
                </td>
              </tr>
              <tr>
                <td>less purchases</td>
                <td className={ui.num}>
                  <Money value={`-${totals.purchases}`} />
                </td>
              </tr>
              <tr>
                <td>plus closing value</td>
                <td className={ui.num}>
                  <Money value={totals.closingValue} />
                </td>
              </tr>
              <tr>
                <td>less opening value{Number(totals.revaluation) !== 0 ? ", revalued" : ""}</td>
                <td className={ui.num}>
                  <Money value={`-${totals.openingRevalued}`} />
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Taxable livestock profit</strong>
                </td>
                <td className={ui.num}>
                  <strong>
                    <Money value={totals.taxableProfit} />
                  </strong>
                </td>
              </tr>
              <tr>
                <td>Herd scheme revaluation (non-taxable, shown separately)</td>
                <td className={ui.num}>
                  <Money value={totals.revaluation} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className={ui.muted}>
          Value bridge: last year&apos;s closing <Money value={totals.openingValue} /> (as reported) + revaluation <Money value={totals.revaluation} /> = opening revalued{" "}
          <Money value={totals.openingRevalued} /> + change in value <Money value={totals.valueChange} /> = closing <Money value={totals.closingValue} />.
        </p>
      </Card>

      {workings.kinds.map((kind) => (
        <Card key={kind.kind} title={`${kind.kindName}: ${kind.method === "herd_scheme" ? "herd scheme" : "national standard cost"}`}>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Class</th>
                  <th className={ui.num}>Opening head</th>
                  <th className={ui.num}>Opening value</th>
                  <th className={ui.num}>{kind.method === "herd_scheme" ? "NAMV per head" : "NSC per head"}</th>
                  {kind.method === "herd_scheme" ? <th className={ui.num}>Opening revalued</th> : null}
                  <th className={ui.num}>Closing head</th>
                  <th className={ui.num}>Closing value</th>
                </tr>
              </thead>
              <tbody>
                {kind.classes.map((entry) => (
                  <tr key={entry.classCode}>
                    <td data-label="Class">{entry.className}</td>
                    <td data-label="Opening head" className={ui.num}>
                      {entry.openingHead}
                    </td>
                    <td data-label="Opening value" className={ui.num}>
                      <Money value={entry.openingValue} />
                    </td>
                    <td data-label="Per head" className={ui.num}>
                      {entry.rate ? <Money value={entry.rate} /> : "Mature group"}
                    </td>
                    {kind.method === "herd_scheme" ? (
                      <td data-label="Opening revalued" className={ui.num}>
                        <Money value={entry.openingRevalued} />
                      </td>
                    ) : null}
                    <td data-label="Closing head" className={ui.num}>
                      {entry.closingHead}
                    </td>
                    <td data-label="Closing value" className={ui.num}>
                      <Money value={entry.closingValue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kind.nsc ? (
            <details>
              <summary>Mature group workings (averaged)</summary>
              <ul>
                <li>
                  Opening: {kind.nsc.matureOpeningHead} head, <Money value={kind.nsc.matureOpeningValue} />
                </li>
                <li>
                  Left in the year: {kind.nsc.matureOut} head; survivors at the opening average: <Money value={kind.nsc.survivorsValue} />
                </li>
                <li>
                  Last year&apos;s rising one-years joining: {kind.nsc.intakeHead} head at their value plus <Money value={kind.nsc.risingTwoRate} /> each:{" "}
                  <Money value={kind.nsc.intakeValue} />
                </li>
                <li>
                  Bought: {kind.nsc.purchasedHead} head at cost <Money value={kind.nsc.purchasedCost} />
                </li>
                <li>
                  Closing: {kind.nsc.matureClosingHead} head, <Money value={kind.nsc.matureClosingValue} /> (average <Money value={kind.nsc.matureAverage} />)
                </li>
              </ul>
            </details>
          ) : null}
          <p className={ui.muted}>
            Sales <Money value={kind.sales} />, purchases <Money value={kind.purchases} />, change in value <Money value={kind.valueChange} />
            {kind.method === "herd_scheme" ? (
              <>
                , revaluation <Money value={kind.revaluation} />
              </>
            ) : null}
            ; taxable profit <Money value={kind.taxableProfit} />.
          </p>
        </Card>
      ))}

      <Card
        title="Journal"
        description={`Posted at ${formatDate(yearEnd)} when approved. The herd scheme revaluation goes to ${revaluationTarget === "reserve" ? "an equity reserve" : "profit and loss, as its own non-taxable line"} (Livestock settings).`}
      >
        {journal.length === 0 ? (
          <p className={ui.muted}>Nothing to post.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Description</th>
                  <th className={ui.num}>Debit</th>
                  <th className={ui.num}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {journal.map((line, index) => (
                  <tr key={index}>
                    <td data-label="Account">
                      {line.accountCode} {line.accountName}
                    </td>
                    <td data-label="Description">{line.description}</td>
                    <td data-label="Debit" className={ui.num}>
                      <Money value={line.debit} blankZero />
                    </td>
                    <td data-label="Credit" className={ui.num}>
                      <Money value={line.credit} blankZero />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can("admin") && !approved ? (
          <Button disabled={busy || problems.length > 0} onClick={() => void approve()}>
            Approve and post
          </Button>
        ) : null}
        {can("admin") && approved ? (
          <div className={ui.inlineForm}>
            <Field label="Why replace it">
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
            <Button variant="danger" disabled={busy || reason.trim() === ""} onClick={() => void replace()}>
              Replace
            </Button>
          </div>
        ) : null}
        {!can("admin") ? <p className={ui.muted}>An admin (the accountant) approves the valuation.</p> : null}
      </Card>
    </>
  );
}

// Settings ---------------------------------------------------------------------------

export function LivestockSettingsPanel({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useLivestockSettings(organisationId);
  const accounts = useAccounts(organisationId);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [firstYearStart, setFirstYearStart] = useState("");
  const isAdmin = can("admin");
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  const current = settings.data.settings;

  async function patch(body: Record<string, unknown>, text: string) {
    setError(null);
    try {
      await api("/api/livestock/settings", { method: "PATCH", body: { organisationId, ...body } });
      setMessage(text);
      settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card title="Livestock" description="Part of Accounting. Dairy cattle, beef cattle and sheep, by IRD's classes.">
        {current.enabled ? (
          <>
            <p>
            On, from the year starting {formatDate(current.firstYearStart)}.{" "}
            {isAdmin ? (
              <Button variant="secondary" size="small" onClick={() => void patch({ enabled: false }, "Livestock turned off. Its records are kept.")}>
                Turn off
              </Button>
            ) : null}
            </p>
            {isAdmin ? (
              <div className={ui.inlineForm}>
                <Field label="First income year starts" hint="Can change until movements are recorded. The opening position is as at the day before.">
                  <input type="date" value={firstYearStart || current.firstYearStart || ""} onChange={(event) => setFirstYearStart(event.target.value)} />
                </Field>
                <Button variant="secondary" disabled={!firstYearStart || firstYearStart === current.firstYearStart} onClick={() => void patch({ firstYearStart }, "The first year is changed.")}>
                  Change
                </Button>
              </div>
            ) : null}
          </>
        ) : isAdmin ? (
          <div className={ui.inlineForm}>
            <Field label="First income year starts" hint="The first day of the financial year Tohyee's livestock records start in. Its opening comes from last year's workpaper.">
              <input type="date" value={firstYearStart || current.firstYearStart || ""} onChange={(event) => setFirstYearStart(event.target.value)} />
            </Field>
            <Button onClick={() => void patch({ enabled: true, firstYearStart: firstYearStart || current.firstYearStart }, "Livestock is on.")}>Turn on</Button>
          </div>
        ) : (
          <p className={ui.muted}>Off. An admin can turn it on.</p>
        )}
      </Card>
      {current.enabled ? (
        <>
          <Card title="Herd scheme revaluation" description="Where the non-taxable revaluation of opening stock goes (LV12). A change applies to the next valuation approved; approved years aren't re-posted.">
            <div className={ui.choiceList} role="radiogroup" aria-label="Herd scheme revaluation">
              {(["profit_and_loss", "reserve"] as const).map((target) => (
                <label key={target}>
                  <input
                    type="radio"
                    disabled={!isAdmin}
                    checked={current.revaluationTarget === target}
                    onChange={() => void patch({ revaluationTarget: target }, "Saved.")}
                  />{" "}
                  {target === "profit_and_loss" ? "Profit and loss, as its own non-taxable line" : "An equity reserve"}
                </label>
              ))}
            </div>
            <div className={ui.grid}>
              {(
                [
                  ["asset", "assetAccount", "Livestock on hand"],
                  ["valueChange", "valueChangeAccount", "Change in value"],
                  ["revaluation", "revaluationAccount", "Herd scheme revaluation (profit and loss)"],
                  ["reserve", "reserveAccount", "Revaluation reserve (equity)"],
                ] as const
              ).map(([role, field, label]) => (
                <Field key={role} label={label}>
                  {isAdmin && accounts.data ? (
                    <AccountSelect accounts={accounts.data.accounts} value={current.accounts[role]?.code ?? ""} onChange={(code) => void patch({ [field]: code }, "Saved.")} />
                  ) : (
                    <span>{current.accounts[role] ? `${current.accounts[role]!.code} ${current.accounts[role]!.name}` : "Not set"}</span>
                  )}
                </Field>
              ))}
            </div>
          </Card>
          <OpeningsCard organisationId={organisationId} canEdit={isAdmin} />
          <ElectionsCard organisationId={organisationId} canEdit={isAdmin} />
          <RatesCard organisationId={organisationId} canEdit={isAdmin} />
          <LocationsCard organisationId={organisationId} canEdit={can("bookkeeper")} />
        </>
      ) : null}
    </>
  );
}

function OpeningsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const openings = useApiData<{ openings: LivestockOpening[] }>("/api/livestock/openings", { organisationId });
  const [draft, setDraft] = useState<Record<string, { head: string; value: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!openings.data) return null;
  const rows = draft ?? Object.fromEntries(openings.data.openings.map((entry) => [`${entry.kind}.${entry.classCode}`, { head: String(entry.head), value: entry.value }]));

  async function save() {
    setError(null);
    try {
      const lines = Object.entries(rows)
        .filter(([, entry]) => entry.head.trim() !== "" && entry.head.trim() !== "0")
        .map(([key, entry]) => {
          const [kind, classCode] = key.split(".");
          return { kind, classCode, head: entry.head, value: entry.value || "0" };
        });
      await api("/api/livestock/openings", { method: "PUT", body: { organisationId, lines } });
      setDraft(null);
      openings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Opening position" description="The first year's opening by class: head and value from last year's workpaper, as at last year's balance date (before ageing). Later years open with the last approved valuation.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {LIVESTOCK_KINDS.map((kind) => (
        <div key={kind} className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <caption>{KIND_NAMES[kind]}</caption>
            <thead>
              <tr>
                <th>Class</th>
                <th className={ui.num}>Head</th>
                <th className={ui.num}>Value</th>
              </tr>
            </thead>
            <tbody>
              {classesOf(kind).map((entry) => {
                const key = `${kind}.${entry.code}`;
                const row = rows[key] ?? { head: "", value: "" };
                return (
                  <tr key={key}>
                    <td data-label="Class">{entry.name}</td>
                    <td data-label="Head" className={ui.num}>
                      {canEdit ? (
                        <input aria-label={`${entry.name} head`} inputMode="numeric" size={7} value={row.head} onChange={(event) => setDraft({ ...rows, [key]: { ...row, head: event.target.value } })} />
                      ) : (
                        row.head
                      )}
                    </td>
                    <td data-label="Value" className={ui.num}>
                      {canEdit ? (
                        <input aria-label={`${entry.name} value`} inputMode="decimal" size={12} value={row.value} onChange={(event) => setDraft({ ...rows, [key]: { ...row, value: event.target.value } })} />
                      ) : (
                        <Money value={row.value} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {canEdit && draft ? <Button onClick={() => void save()}>Save opening</Button> : null}
    </Card>
  );
}

function ElectionsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const elections = useApiData<{ elections: Election[] }>("/api/livestock/elections", { organisationId });
  const [form, setForm] = useState({ kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: "", note: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await api("/api/livestock/elections", { method: "POST", body: { organisationId, ...form } });
      setForm({ ...form, fromIncomeYear: "", note: "" });
      elections.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Elections" description="Each kind's valuation method from an income year, with the evidence attached. Recording one here files nothing with IRD.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {elections.data && elections.data.elections.length === 0 ? <Empty>No elections recorded.</Empty> : null}
      <ul>
        {elections.data?.elections.map((election) => (
          <li key={election.id}>
            {election.kindName}: {election.methodName} from the {election.fromIncomeYear} income year{election.note ? ` (${election.note})` : ""}.{" "}
            <button type="button" className={ui.linkButton} onClick={() => setOpen(open === election.id ? null : election.id)}>
              {open === election.id ? "Hide evidence" : "Evidence"}
            </button>
            {open === election.id ? <RecordExtrasPanel organisationId={organisationId} recordType="livestock_election" recordId={election.id} /> : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Livestock">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              {LIVESTOCK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_NAMES[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Method">
            <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>
              <option value="herd_scheme">Herd scheme</option>
              <option value="nsc">National standard cost</option>
            </select>
          </Field>
          <Field label="From income year" hint="2026 = the 2025-26 income year">
            <input inputMode="numeric" size={6} value={form.fromIncomeYear} onChange={(event) => setForm({ ...form, fromIncomeYear: event.target.value })} />
          </Field>
          <Field label="Note">
            <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </Field>
          <Button disabled={form.fromIncomeYear.trim() === ""} onClick={() => void save()}>
            Record election
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function RatesCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const rates = useApiData<{ rates: Rate[] }>("/api/livestock/rates", { organisationId });
  const [form, setForm] = useState({ incomeYear: "", rateKind: "namv", kind: "dairy_cattle", category: "ma_cows", amount: "", source: "" });
  const [error, setError] = useState<string | null>(null);
  const years = [...new Set((rates.data?.rates ?? []).map((rate) => rate.incomeYear))];

  async function save() {
    setError(null);
    try {
      await api("/api/livestock/rates", { method: "PUT", body: { organisationId, ...form } });
      setForm({ ...form, amount: "" });
      rates.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const categories =
    form.rateKind === "namv"
      ? classesOf(form.kind as LivestockKind).map((entry) => [entry.code, entry.name] as const)
      : ([
          ["rising_1", "Rising 1 year"],
          ["rising_2", "Rising 2 year"],
          ["purchased_bobby_calves", "Purchased bobby calves"],
        ] as const);

  return (
    <Card title="IRD rates" description="National average market values (herd scheme) and national standard costs, by income year, with where each came from. A year's rates can't change once a valuation using them is approved.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {years.map((year) => (
        <details key={year}>
          <summary>
            {year - 1}-{String(year).slice(2)} income year ({year})
          </summary>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Rate</th>
                  <th>Livestock</th>
                  <th>Class</th>
                  <th className={ui.num}>Per head</th>
                </tr>
              </thead>
              <tbody>
                {rates.data!.rates
                  .filter((rate) => rate.incomeYear === year)
                  .map((rate) => (
                    <tr key={rate.id} title={rate.source}>
                      <td data-label="Rate">{rate.rateKind === "namv" ? "NAMV" : "NSC"}</td>
                      <td data-label="Livestock">{KIND_NAMES[rate.kind]}</td>
                      <td data-label="Class">{rate.categoryName}</td>
                      <td data-label="Per head" className={ui.num}>
                        <Money value={rate.amount} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className={ui.muted}>Source: {[...new Set(rates.data!.rates.filter((rate) => rate.incomeYear === year).map((rate) => rate.source))].join("; ")}</p>
        </details>
      ))}
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Income year">
            <input inputMode="numeric" size={6} value={form.incomeYear} onChange={(event) => setForm({ ...form, incomeYear: event.target.value })} />
          </Field>
          <Field label="Rate">
            <select value={form.rateKind} onChange={(event) => setForm({ ...form, rateKind: event.target.value, category: event.target.value === "namv" ? classesOf(form.kind as LivestockKind)[0].code : "rising_1" })}>
              <option value="namv">NAMV</option>
              <option value="nsc">NSC</option>
            </select>
          </Field>
          <Field label="Livestock">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value, category: form.rateKind === "namv" ? classesOf(event.target.value as LivestockKind)[0].code : form.category })}>
              {LIVESTOCK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_NAMES[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Class">
            <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {categories.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Per head">
            <input inputMode="decimal" size={9} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
          </Field>
          <Field label="Source" hint="The determination and its link">
            <input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} />
          </Field>
          <Button disabled={!form.incomeYear || !form.amount || !form.source} onClick={() => void save()}>
            Save rate
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function LocationsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const locations = useApiData<{ locations: LivestockLocation[] }>("/api/livestock/locations", { organisationId });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      await api("/api/livestock/locations", { method: "POST", body: { organisationId, name } });
      setName("");
      locations.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function archive(location: LivestockLocation) {
    try {
      await api(`/api/livestock/locations/${location.id}`, { method: "PATCH", body: { organisationId, archived: !location.archived } });
      locations.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Locations" description="Farms, blocks and grazing places. Moving stock between them doesn't change the head count.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul>
        {locations.data?.locations.map((location) => (
          <li key={location.id}>
            {location.name} {location.archived ? <Badge tone="neutral">Archived</Badge> : null}{" "}
            {canEdit ? (
              <button type="button" className={ui.linkButton} onClick={() => void archive(location)}>
                {location.archived ? "Restore" : "Archive"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="New location">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button disabled={name.trim() === ""} onClick={() => void add()}>
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
