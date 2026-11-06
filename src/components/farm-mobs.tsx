"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BigNumber, Choices, DayChoice, Step } from "@/components/farm-log";
import { FarmRowList } from "@/components/farm-rows";
import { BreedingFlow, breedingTypesFor, MobBreeding, PlanRoundFlow, RotationCard, useRotation } from "@/components/farm-planning";
import { FarmTermsCard, useFarmTerms } from "@/components/farm-timeline";
import { ProductStockCard, TreatFlow, TreatmentsCard } from "@/components/farm-treatments";
import { classTerm, type FarmTerms, term } from "@/lib/farming/farm-terms";
import { BREEDING_LABELS, type BreedingType } from "@/lib/farming/planning-rules";
import type { RotationPlan } from "@/lib/farming/planning";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { MoreMenu } from "@/components/more-menu";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Button, Card, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { daysAgo, shortDate } from "@/lib/farming/farm-words";
import type { ActionResult, FarmStocking, LinkableMovement, Mob, MobEvent, MobImportPreview, MobWeight, UntypedMob } from "@/lib/farming/mobs";
import { BOOKKEEPER_ACTIONS, paddockLabel, CREATED_HOW, CREATED_HOW_LABELS, type CreatedHow, gainText, isBirthClass, MOB_ACTION_LABELS, MOB_ACTIONS, MOB_EVENT_LABELS, type MobAction, OFFLINE_ACTIONS } from "@/lib/farming/mob-rules";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import { STOCK_UNIT_SOURCE, type StockUnitFactor } from "@/lib/farming/stock-units";
import { withheld, withholdingText } from "@/lib/farming/treatment-rules";
import { formatDate, todayInBrowser } from "@/lib/format";
import { classesOf, className, KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Mobs on the farm (decisions 1421-1430): the list with each mob's head,
 * class, paddock and last weight; quick actions as one-question steps;
 * stocking rate; making mob records from typed grazings; importing mobs.
 * Moves, weights, deaths, births and counts go through the device's queue,
 * so they work without a signal.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

type Flow = { kind: "add" } | { kind: "action"; action: MobAction; mob: Mob } | { kind: "treat"; mob: Mob } | { kind: "breeding"; mob: Mob; recordType: BreedingType } | { kind: "plan" };
type MobFlowKind = Extract<Flow, { kind: "add" } | { kind: "action" }>;

function useMobs(organisationId: string, farmId: string) {
  return useApiData<{ mobs: Mob[] }>(`/api/farming/farms/${farmId}/mobs`, { organisationId });
}

export function mobLine(mob: Mob, today: string, plan: RotationPlan | null = null, terms: FarmTerms = {}): string[] {
  const next = plan?.nextByMob[mob.id];
  return [
    `${mob.head.toLocaleString("en-NZ")} head`,
    term(terms, `class:${mob.kind}.${mob.classCode}`, mob.className),
    mob.paddock ? `${paddockLabel(mob.paddock.name)} since ${shortDate(mob.paddock.inOn, today)}` : "Not in a paddock",
    mob.lastWeight ? `${mob.lastWeight.averageKg} kg ${shortDate(mob.lastWeight.date, today)}` : "",
    withholdingText(mob.withholding, today, (iso) => shortDate(iso, today)) ?? "",
    next ? `next: ${paddockLabel(next.paddockName)} ${shortDate(next.plannedOn, today)}` : "",
  ].filter(Boolean);
}

function TagSwatch({ colour }: { colour: string | null }) {
  if (!colour) return null;
  return <span aria-label={`${colour} tag`} title={`${colour} tag`} style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, border: "1px solid var(--border)", background: /^[a-z]+$/i.test(colour) ? colour.toLowerCase() : "var(--surface-sunken)" }} />;
}

export function FarmMobs({ organisationId, farm }: FarmContext) {
  const today = todayInBrowser();
  const { can } = useWorkspace();
  const canRecord = useCanRecordFarmWork();
  const mobs = useMobs(organisationId, farm.id);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const list = [...(mobs.data?.mobs ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name));
  const mob = list.find((entry) => entry.id === selected) ?? null;
  const [version, setVersion] = useState(0);
  const rotation = useRotation(organisationId, farm.id, version);
  const terms = useFarmTerms(organisationId);
  const reload = () => {
    mobs.reload();
    setVersion((value) => value + 1);
  };
  const closeFlow = (message: string | null) => {
    setFlow(null);
    if (message) setDone(message);
    reload();
  };

  if (flow?.kind === "breeding") return <BreedingFlow organisationId={organisationId} farm={farm} mob={flow.mob} mobs={list} recordType={flow.recordType} onClose={closeFlow} />;
  if (flow?.kind === "plan") return <PlanRoundFlow organisationId={organisationId} farm={farm} mobs={list} roundDays={rotation.data?.plan.roundDays ?? null} onClose={closeFlow} />;

  if (flow?.kind === "treat") {
    return (
      <TreatFlow
        organisationId={organisationId}
        farm={farm}
        mob={flow.mob}
        onClose={(message) => {
          setFlow(null);
          if (message) setDone(message);
          reload();
        }}
      />
    );
  }

  if (flow) {
    return (
      <MobFlow
        organisationId={organisationId}
        farm={farm}
        flow={flow}
        mobs={list}
        onClose={(message) => {
          setFlow(null);
          if (message) setDone(message);
          reload();
        }}
      />
    );
  }

  return (
    <div className={styles.grid}>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        {done ? <Notice tone="success">{done}</Notice> : null}
        <Card
          title={term(terms, "mobs")}
          actions={
            canRecord ? (
              <Button
                onClick={() => {
                  setDone(null);
                  setFlow({ kind: "add" });
                }}
              >
                Add a {term(terms, "mob").toLowerCase()}
              </Button>
            ) : null
          }
        >
          {mobs.error ? <Notice tone="error">{mobs.error}</Notice> : null}
          {!mobs.data && !mobs.error ? <p className={ui.muted}>Loading…</p> : null}
          {mobs.data && !list.length ? <p>No mobs yet. Add one, or make them from the mob names on your grazings.</p> : null}
          {list.length ? (
            <FarmRowList
              label="Mobs"
              rows={list.map((entry) => ({
                key: entry.id,
                title: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <TagSwatch colour={entry.tagColour} />
                    {entry.name}
                  </span>
                ),
                parts: mobLine(entry, today, rotation.data?.plan ?? null, terms),
                onOpen: () => {
                  setSelected(entry.id);
                  requestAnimationFrame(() => document.getElementById("mob-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                },
              }))}
            />
          ) : null}
        </Card>
        <div id="mob-card" style={{ scrollMarginTop: 64 }}>
          {mob ? (
            <MobCard
              key={`${mob.id}:${mob.head}:${mob.classCode}:${mob.paddock?.id ?? ""}:${mob.lastWeight?.date ?? ""}`}
              organisationId={organisationId}
              mob={mob}
              canRecord={canRecord}
              canBooks={can("bookkeeper")}
              terms={terms}
              mobs={list}
              onChanged={(message) => {
                setDone(message);
                reload();
              }}
              onAction={(action) => {
                setDone(null);
                if (action === "treat") setFlow({ kind: "treat", mob });
                else if (action.startsWith("breeding:")) setFlow({ kind: "breeding", mob, recordType: action.slice(9) as BreedingType });
                else setFlow({ kind: "action", action: action as MobAction, mob });
              }}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </div>
      </div>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <StockingCard organisationId={organisationId} farmId={farm.id} version={list.map((entry) => `${entry.id}:${entry.head}:${entry.classCode}:${entry.paddock?.id ?? ""}`).join(",")} canEdit={can("admin")} />
        <RotationCard organisationId={organisationId} farmId={farm.id} plan={rotation.data?.plan ?? null} onChanged={reload} onPlan={() => (setDone(null), setFlow({ kind: "plan" }))} />
        <TreatmentsCard organisationId={organisationId} farmId={farm.id} version={version} />
        <ProductStockCard organisationId={organisationId} farmId={farm.id} version={version} />
        {can("bookkeeper") ? <TypedMobs organisationId={organisationId} farmId={farm.id} onMade={reload} /> : null}
        {can("bookkeeper") ? <ImportMobs organisationId={organisationId} farmId={farm.id} onImported={reload} /> : null}
        <FarmTermsCard organisationId={organisationId} />
      </div>
    </div>
  );
}

function MobCard({ organisationId, mob, mobs, canRecord, canBooks, terms, onAction, onChanged, onClose }: { organisationId: string; mob: Mob; mobs: Mob[]; canRecord: boolean; canBooks: boolean; terms: FarmTerms; onAction: (action: MobAction | "treat" | `breeding:${BreedingType}`) => void; onChanged: (message: string) => void; onClose: () => void }) {
  const today = todayInBrowser();
  const detail = useApiData<{ mob: Mob; events: MobEvent[]; weights: MobWeight[] }>(`/api/farming/mobs/${mob.id}`, { organisationId });
  const actions = MOB_ACTIONS.filter((action) => (BOOKKEEPER_ACTIONS.includes(action) ? canBooks : canRecord)).filter((action) => action !== "births" || isBirthClass(mob.kind, mob.classCode));
  const events = detail.data?.events ?? [];
  const MAIN: Array<MobAction | "treat"> = ["move", "weigh", "treat", "deaths"];
  const main = MAIN.filter((action) => action === "treat" || actions.includes(action));
  const others = actions.filter((action) => !MAIN.includes(action));
  return (
    <Card title={mob.name} actions={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {withholdingText(mob.withholding, today) ? <Notice tone="warning">{withholdingText(mob.withholding, today, (iso) => shortDate(iso, today))}</Notice> : null}
      <dl className={styles.facts}>
        <dt>Head</dt>
        <dd>{mob.head.toLocaleString("en-NZ")}</dd>
        <dt>Class</dt>
        <dd>
          {term(terms, `kind:${mob.kind}`, mob.kindName)}: {classTerm(terms, mob.kind, mob.classCode, mob.className)}{" "}
          <InfoTip label="Class">The IRD class the books count this mob in. Selling, buying, deaths, births and class changes here change the livestock head count too, when Livestock is on.</InfoTip>
        </dd>
        <dt>Paddock</dt>
        <dd>{mob.paddock ? `${paddockLabel(mob.paddock.name)}, in ${shortDate(mob.paddock.inOn, today)} (${daysAgo(mob.paddock.inOn, today)})` : "Not in a paddock"}</dd>
        <dt>Weight</dt>
        <dd>{mob.lastWeight ? `${mob.lastWeight.averageKg} kg average on ${shortDate(mob.lastWeight.date, today)}${mob.lastWeight.gain ? `, ${gainText(mob.lastWeight.gain)}` : ""}` : "Not weighed yet"}</dd>
        <dt>Stock units</dt>
        <dd>{mob.stockUnits ?? "–"}</dd>
        {mob.tagColour ? (
          <>
            <dt>Tag</dt>
            <dd>{mob.tagColour}</dd>
          </>
        ) : null}
      </dl>
      {canRecord ? (
        // The field work first, as big buttons; the rest in the "⋯" menu (decision 1321).
        <div className={styles.bigButtons} role="group" aria-label={`Actions for ${mob.name}`}>
          {main.map((action) => (
            <button key={action} type="button" className={styles.bigButton} onClick={() => onAction(action)}>
              {term(terms, `action:${action}`, action === "treat" ? "Treat" : MOB_ACTION_LABELS[action])}
            </button>
          ))}
        </div>
      ) : null}
      {others.length || canRecord ? (
        <div className={styles.actions}>
          <MoreMenu
            label={`More actions for ${mob.name}`}
            text="More actions"
            items={[
              ...others.map((action) => ({ label: term(terms, `action:${action}`, MOB_ACTION_LABELS[action]), onSelect: () => onAction(action) })),
              ...(canRecord ? breedingTypesFor(mob).map((type) => ({ label: `Record ${BREEDING_LABELS[type].toLowerCase()}`, onSelect: () => onAction(`breeding:${type}`) })) : []),
            ]}
          />
        </div>
      ) : null}
      <MobBreeding organisationId={organisationId} mob={mob} version={`${mob.head}:${mob.classCode}`} />
      <h3>History</h3>
      <p>
        <Link href={`/operations/farm/timeline?farm=${mob.farmId}&mob=${mob.id}`}>Timeline for {mob.name}</Link>
      </p>
      {detail.error ? <Notice tone="error">{detail.error}</Notice> : null}
      {events.length ? (
        <FarmRowList
          label={`${mob.name} history`}
          rows={events.slice(0, 12).map((event) => ({
            key: event.id,
            title: shortDate(event.eventDate, today),
            parts: [eventText(event), event.livestockMovementId ? "in the head count" : ""],
            details: canBooks && isReversible(event) && !reversedIds(events).has(event.id) ? (
              <ReverseEvent organisationId={organisationId} mob={mob} mobs={mobs} event={event} onDone={onChanged} />
            ) : undefined,
          }))}
        />
      ) : (
        <p className={ui.muted}>{detail.data ? "Nothing yet." : "Loading…"}</p>
      )}
    </Card>
  );
}

/** A sale, death, birth, purchase or class change, or a mob added as bought or born, can be reversed (#609). */
function isReversible(event: MobEvent): boolean {
  return ["sold", "died", "born", "bought", "reclass"].includes(event.eventType) || (event.eventType === "created" && (event.createdHow === "bought" || event.createdHow === "born"));
}

function reversedIds(events: MobEvent[]): Set<string> {
  return new Set(events.filter((event) => event.reversesEventId).map((event) => event.reversesEventId!));
}

/**
 * Reversing an event (#609, decisions 1500-1503): the mob and the books'
 * livestock movement together, with why. If the mob has changed since,
 * Tohyee asks which mob the animals go back into.
 */
function ReverseEvent({ organisationId, mob, mobs, event, onDone }: { organisationId: string; mob: Mob; mobs: Mob[]; event: MobEvent; onDone: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [intoMobId, setIntoMobId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const same = mobs.filter((entry) => entry.kind === mob.kind && entry.status === "active");
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ActionResult>(`/api/farming/mobs/${mob.id}/actions`, { method: "POST", body: { organisationId, action: "reverse", eventId: event.id, reason, intoMobId: intoMobId || null } });
      onDone(result.message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Why it's being reversed">
        <input value={reason} maxLength={300} placeholder="e.g. entered twice" onChange={(changed) => setReason(changed.target.value)} />
      </Field>
      {event.eventType !== "reclass" ? (
        <Field label="Back into">
          <select value={intoMobId} onChange={(changed) => setIntoMobId(changed.target.value)}>
            <option value="">{mob.name}</option>
            {same.filter((entry) => entry.id !== mob.id).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={styles.actions}>
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void send()}>
          Reverse this
        </Button>
        <InfoTip label="Reversing">It adds a reversal to the history (nothing is deleted) and voids the books&apos; livestock movement in the same step. If the mob has moved, split, merged or closed since, choose the mob the animals go back into.</InfoTip>
      </div>
    </div>
  );
}

export function eventText(event: MobEvent): string {
  const label = MOB_EVENT_LABELS[event.eventType];
  switch (event.eventType) {
    case "moved":
      return event.toPaddockName ? `${label} to ${event.toPaddockName}${event.fromPaddockName ? ` from ${event.fromPaddockName}` : ""}` : `Out of ${event.fromPaddockName ?? "the paddock"}`;
    case "weighed":
      return `${label}: ${event.averageKg} kg average${event.weighedHead ? ` (${event.weighedHead} weighed)` : ""}`;
    case "reclass":
      return `${label}: ${className(event.kind, event.fromClassCode ?? "")} to ${className(event.kind, event.toClassCode ?? "")}`;
    case "split_out":
    case "split_in":
    case "merged_out":
    case "merged_in":
      return `${label} ${event.otherMobName ?? ""}: ${Math.abs(event.headChange)} head`;
    case "reversed":
      return `${label}: ${event.headChange > 0 ? "+" : ""}${event.headChange} head${event.otherMobName ? ` (from ${event.otherMobName})` : ""}${event.note ? `, ${event.note}` : ""}`;
    case "created":
      return `${label}: ${event.headAfter} head${event.toPaddockName ? ` in ${event.toPaddockName}` : ""}`;
    default:
      return `${label}: ${Math.abs(event.headChange)} head${event.amount ? `, $${event.amount}` : ""}`;
  }
}

// Stocking rate ------------------------------------------------------------------------------------

function StockingCard({ organisationId, farmId, version, canEdit }: { organisationId: string; farmId: string; version: string; canEdit: boolean }) {
  const stocking = useApiData<{ stocking: FarmStocking }>(`/api/farming/farms/${farmId}/stocking`, { organisationId });
  const { reload } = stocking;
  useEffect(() => reload(), [version, reload]);
  const [editing, setEditing] = useState(false);
  const data = stocking.data?.stocking;
  return (
    <Card
      title="Stocking rate now"
      description={
        <>
          From the mobs on the farm today.{" "}
          <InfoTip label="Stock units">
            {STOCK_UNIT_SOURCE} The factors are a guide, not a rule: change them to suit your stock. Area is the effective hectares of active paddocks (mapped hectares where none are typed).
          </InfoTip>
        </>
      }
    >
      {stocking.error ? <Notice tone="error">{stocking.error}</Notice> : null}
      {data ? (
        <>
          <div className={styles.tiles}>
            <Stat label="SU/ha" value={data.farm.suPerHa ?? "–"} />
            <Stat label="Head/ha" value={data.farm.headPerHa ?? "–"} />
            <Stat label="Stock units" value={data.farm.stockUnits} />
            <Stat label="Hectares" value={data.farm.hectares ?? "–"} />
          </div>
          {data.untypedHead ? <Notice tone="info">{data.untypedHead.toLocaleString("en-NZ")} head on grazings without a mob record aren&apos;t counted. Make them mob records to count them.</Notice> : null}
          {data.paddocks.length ? (
            <FarmRowList
              label="Stocking by paddock"
              rows={data.paddocks.map((paddock) => ({ key: paddock.paddockId, title: paddockLabel(paddock.name), parts: [paddock.suPerHa ? `${paddock.suPerHa} SU/ha` : "No area", paddock.headPerHa ? `${paddock.headPerHa} head/ha` : "", paddock.mobs.join(", ")] }))}
            />
          ) : null}
          <details open={editing} onToggle={(event) => setEditing((event.target as HTMLDetailsElement).open)}>
            <summary className={ui.linkButton}>Stock unit factors</summary>
            {editing ? <FactorTable organisationId={organisationId} factors={data.factors} canEdit={canEdit} onSaved={stocking.reload} /> : null}
          </details>
        </>
      ) : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}

function FactorTable({ organisationId, factors, canEdit, onSaved }: { organisationId: string; factors: StockUnitFactor[]; canEdit: boolean; onSaved: () => void }) {
  const [kind, setKind] = useState<LivestockKind>("sheep");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = factors.filter((entry) => entry.kind === kind);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(values).map(([classCode, factor]) => ({ kind, classCode, factor }));
      await api("/api/farming/stock-units", { method: "PUT", body: { organisationId, lines } });
      setValues({});
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Field label="Kind of stock">
        <select value={kind} onChange={(event) => (setKind(event.target.value as LivestockKind), setValues({}))}>
          {LIVESTOCK_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_NAMES[entry]}
            </option>
          ))}
        </select>
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Class</th>
              <th className={ui.num}>SU each</th>
              <th>Based on</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.classCode}>
                <td data-label="Class">{className(entry.kind, entry.classCode)}</td>
                <td data-label="SU each" className={ui.num}>
                  {canEdit ? (
                    <input
                      aria-label={`${className(entry.kind, entry.classCode)} stock units each`}
                      inputMode="decimal"
                      style={{ width: "7ch", textAlign: "right" }}
                      value={values[entry.classCode] ?? entry.factor}
                      onChange={(event) => setValues((current) => ({ ...current, [entry.classCode]: event.target.value }))}
                    />
                  ) : (
                    entry.factor
                  )}
                </td>
                <td data-label="Based on">{entry.changed ? `Changed (default ${entry.defaultFactor})` : entry.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <div className={styles.actions}>
          <Button variant="secondary" disabled={busy || !Object.keys(values).length} onClick={() => void save()}>
            Save factors
          </Button>
          <span className={ui.muted}>Clear a box to go back to the default.</span>
        </div>
      ) : null}
    </div>
  );
}

// Typed mob names on grazings ----------------------------------------------------------------------

function TypedMobs({ organisationId, farmId, onMade }: { organisationId: string; farmId: string; onMade: () => void }) {
  const typed = useApiData<{ mobs: UntypedMob[] }>(`/api/farming/farms/${farmId}/mobs/from-grazings`, { organisationId });
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<LivestockKind>("sheep");
  const [classCode, setClassCode] = useState("");
  const [head, setHead] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const list = typed.data?.mobs ?? [];
  if (!list.length && !message) return null;
  const make = async (entry: UntypedMob) => {
    setError(null);
    try {
      const result = await api<ActionResult>(`/api/farming/farms/${farmId}/mobs/from-grazings`, { method: "POST", body: { organisationId, mob: entry.mob, kind, classCode, head: head || entry.head } });
      setMessage(result.message);
      setOpen(null);
      typed.reload();
      onMade();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Mob names on grazings"
      description={
        <>
          Typed on grazings, with no mob record.{" "}
          <InfoTip label="Mob records">Make one a mob record to give it a class and head, count it in the stocking rate and move it from Mobs. Its grazings, past and present, become the mob&apos;s.</InfoTip>
        </>
      }
    >
      {message ? <Notice tone="success">{message}</Notice> : null}
      <FarmRowList
        label="Mob names on grazings"
        rows={list.map((entry) => ({
          key: entry.mob,
          title: entry.mob,
          parts: [entry.head ? `${entry.head} head last time` : "", entry.openIn.length ? `in ${entry.openIn.join(", ")}` : "not in now", `${entry.grazings} grazing${entry.grazings === 1 ? "" : "s"}`],
          details:
            open === entry.mob ? (
              <div style={{ display: "grid", gap: 8 }}>
                {error ? <Notice tone="error">{error}</Notice> : null}
                <ClassPicker kind={kind} classCode={classCode} onChange={(nextKind, nextClass) => (setKind(nextKind), setClassCode(nextClass))} />
                <Field label="Head">
                  <input inputMode="numeric" value={head || String(entry.head ?? "")} onChange={(event) => setHead(event.target.value)} />
                </Field>
                <Button disabled={!classCode} onClick={() => void make(entry)}>
                  Make a mob record
                </Button>
              </div>
            ) : undefined,
          actions:
            open === entry.mob ? undefined : (
              <Button variant="secondary" onClick={() => (setOpen(entry.mob), setError(null), setHead(""))}>
                Make a mob record
              </Button>
            ),
        }))}
      />
    </Card>
  );
}

function ClassPicker({ kind, classCode, onChange }: { kind: LivestockKind; classCode: string; onChange: (kind: LivestockKind, classCode: string) => void }) {
  return (
    <>
      <Field label="Kind of stock">
        <select value={kind} onChange={(event) => onChange(event.target.value as LivestockKind, "")}>
          {LIVESTOCK_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_NAMES[entry]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Class">
        <select value={classCode} onChange={(event) => onChange(kind, event.target.value)}>
          <option value="">Choose…</option>
          {classesOf(kind).map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

// Import -------------------------------------------------------------------------------------------

function ImportMobs({ organisationId, farmId, onImported }: { organisationId: string; farmId: string; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [preview, setPreview] = useState<MobImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const path = `/api/farming/farms/${farmId}/mobs/import`;
  const send = async <T,>(preview: boolean) => api<T>(path, { method: "POST", body: { organisationId, fileName: file?.name, content: file?.content, contentBase64: file?.contentBase64, preview } });
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!picked) return setFile(null);
    if (/\.xlsx$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else setFile({ name: picked.name, content: await picked.text() });
  };
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="Import mobs">
      <details>
        <summary className={ui.linkButton}>Import a file</summary>
        <p className={ui.muted}>
          A row per mob: kind (or species), class, head, and if you like the mob&apos;s name, paddock, tag colour and date.{" "}
          <InfoTip label="Importing mobs">Mobs come in as already on the farm, so the books&apos; head count isn&apos;t changed. Classes are IRD&apos;s names, such as &quot;Two-tooth ewes&quot;. Nothing is saved until you import.</InfoTip>
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="File">
            <input key={picker} type="file" accept=".csv,.xlsx,text/csv" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button variant="secondary" disabled={!file} onClick={() => void run(async () => setPreview((await send<{ preview: MobImportPreview }>(true)).preview))}>
            Preview
          </Button>
        </div>
        {preview ? (
          <>
            {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
            <p>
              {preview.counts.mobs} mob{preview.counts.mobs === 1 ? "" : "s"} to import{preview.counts.errors ? `, ${preview.counts.errors} skipped` : ""}.
            </p>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Mob</th>
                    <th>Class</th>
                    <th className={ui.num}>Head</th>
                    <th>Paddock</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.line}>
                      <td data-label="Line">{row.line}</td>
                      <td data-label="Mob">{row.name ?? "–"}</td>
                      <td data-label="Class">{row.kind && row.classCode ? className(row.kind, row.classCode) : "–"}</td>
                      <td data-label="Head" className={ui.num}>
                        {row.head ?? "–"}
                      </td>
                      <td data-label="Paddock">{row.paddockName ?? "–"}</td>
                      <td data-label="Problem">{row.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              disabled={!preview.counts.mobs || Boolean(preview.alreadyImportedOn)}
              onClick={() =>
                void run(async () => {
                  const result = await send<{ imported: number; skipped: number }>(false);
                  setDone(`Imported ${result.imported} mob${result.imported === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} skipped` : ""}.`);
                  setPreview(null);
                  setFile(null);
                  setPicker((value) => value + 1);
                  onImported();
                })
              }
            >
              Import
            </Button>
          </>
        ) : null}
      </details>
    </Card>
  );
}

// The step flows -----------------------------------------------------------------------------------

type Answers = {
  kind: LivestockKind;
  classCode: string;
  head: string;
  how: CreatedHow;
  paddockId: string | null;
  name: string;
  tagColour: string;
  day: string;
  averageKg: string;
  weighedHead: string;
  amount: string;
  intoMobId: string | null;
  toClassCode: string;
  note: string;
  movementId: string | null;
};

function stepsFor(flow: MobFlowKind): string[] {
  if (flow.kind === "add") return ["kind", "class", "head", "how", "paddockOptional", "name", "day", "review"];
  switch (flow.action) {
    case "move":
      return ["paddock", "day", "review"];
    case "weigh":
      return ["averageKg", "weighedHead", "day", "review"];
    case "deaths":
    case "births":
    case "count":
      return ["head", "day", "review"];
    case "sell":
    case "buy":
      return ["link", "head", "amount", "day", "review"];
    case "split":
      return ["head", "name", "paddockOptional", "day", "review"];
    case "merge":
      return ["into", "day", "review"];
    case "reclass":
      return ["toClass", "day", "review"];
  }
}

const QUESTION: Partial<Record<MobAction, string>> = {
  deaths: "How many died?",
  births: "How many were born?",
  count: "How many are in the mob now?",
  sell: "How many were sold?",
  buy: "How many were bought?",
  split: "How many go into the new mob?",
};

function MobFlow({ organisationId, farm, flow, mobs, onClose }: Pick<FarmContext, "organisationId" | "farm"> & { flow: MobFlowKind; mobs: Mob[]; onClose: (message: string | null) => void }) {
  const today = todayInBrowser();
  const { queue } = useOfflineQueue(organisationId);
  const statuses = useApiData<{ paddocks: PaddockStatus[] }>(`/api/farming/farms/${farm.id}/paddock-status`, { organisationId, onDate: today });
  const mob = flow.kind === "action" ? flow.mob : null;
  const linkType = flow.kind === "action" && (flow.action === "sell" || flow.action === "buy") ? (flow.action === "sell" ? "sale" : "purchase") : null;
  const linkable = useApiData<{ movements: LinkableMovement[] }>(linkType && mob ? `/api/farming/mobs/${mob.id}/movements` : null, { organisationId, type: linkType });
  const allSteps = stepsFor(flow);
  const [linkedOnly, setLinkedOnly] = useState(false);
  // No movements to link: the question isn't asked. Linking one gives its head and date, so only the check is left.
  const steps = allSteps.filter((entry) => entry !== "link" || (linkable.data?.movements.length ?? 0) > 0).filter((entry) => !linkedOnly || entry === "link" || entry === "review");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({
    kind: mob?.kind ?? "sheep",
    classCode: mob?.classCode ?? "",
    head: "",
    how: "on_farm",
    paddockId: null,
    name: "",
    tagColour: "",
    day: today,
    averageKg: "",
    weighedHead: "",
    amount: "",
    intoMobId: null,
    toClassCode: "",
    note: "",
    movementId: null,
  });
  const set = (patch: Partial<Answers>) => setAnswers((current) => ({ ...current, ...patch }));
  const step = steps[index];
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => (index === 0 ? onClose(null) : setIndex((value) => value - 1));
  const title = flow.kind === "add" ? `Add a mob · ${farm.name}` : `${MOB_ACTION_LABELS[flow.action]} · ${mob!.name}`;
  const frame = { title, step: index + 1, steps: steps.length, onBack: back };
  const paddocks = [...(statuses.data?.paddocks ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name));
  const headOk = /^\d{1,6}$/.test(answers.head.replace(/,/g, "")) && Number(answers.head.replace(/,/g, "")) >= 1;
  const paddockName = (id: string | null) => paddocks.find((entry) => entry.paddockId === id)?.name ?? null;
  const books = (flow.kind === "action" ? ["sell", "buy", "deaths", "births", "reclass"].includes(flow.action) : answers.how !== "on_farm") && !answers.movementId;

  const save = async () => {
    setBusy(true);
    setError(null);
    const operationId = newOperationId();
    const head = answers.head.replace(/,/g, "");
    try {
      if (flow.kind === "add") {
        const result = await api<ActionResult>(`/api/farming/farms/${farm.id}/mobs`, {
          method: "POST",
          body: { organisationId, operationId, name: answers.name.trim() || null, kind: answers.kind, classCode: answers.classCode, head, how: answers.how, paddockId: answers.paddockId, tagColour: answers.tagColour.trim() || null, onDate: answers.day },
        });
        return onClose(result.message);
      }
      const action = flow.action;
      const body: Record<string, unknown> = { action, farmId: farm.id, onDate: answers.day };
      if (action === "move") body.toPaddockId = answers.paddockId;
      if (action === "weigh") Object.assign(body, { averageKg: answers.averageKg, weighedHead: answers.weighedHead || null });
      if (["deaths", "births", "count", "sell", "buy", "split"].includes(action)) body.head = head;
      if (action === "sell" || action === "buy") Object.assign(body, { amount: answers.amount || null, movementId: answers.movementId });
      if (action === "split") Object.assign(body, { name: answers.name.trim() || null, toPaddockId: answers.paddockId });
      if (action === "merge") body.intoMobId = answers.intoMobId;
      if (action === "reclass") body.toClassCode = answers.toClassCode;
      const path = `/api/farming/mobs/${mob!.id}/actions`;
      if (OFFLINE_ACTIONS.includes(action)) {
        // Field work goes through the device's queue, so it keeps with no signal (decision 1428).
        const outcome = await submitThroughQueue(queue, { operationId, kind: `mob.${action}`, label: `${MOB_ACTION_LABELS[action]}: ${mob!.name}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path, body } });
        return onClose(outcome.state === "synced" ? ((outcome.result as ActionResult | undefined)?.message ?? "Saved.") : "Kept on this device. It goes when Tohyee can be reached.");
      }
      const result = await api<ActionResult>(path, { method: "POST", body: { ...body, organisationId, operationId } });
      onClose(result.message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const errorNote = error ? <Notice tone="error">Not saved: {error}</Notice> : null;

  switch (step) {
    case "link": {
      const movements = linkable.data?.movements ?? [];
      return (
        <Step {...frame} question={`Is this ${linkType} already in the books?`}>
          <Choices
            options={[
              { value: "__new", label: "No, record it now", note: "Adds a livestock movement" },
              ...movements.map((movement) => ({
                value: movement.id,
                label: `${movement.head} head on ${shortDate(movement.movementDate, today)}`,
                note: [movement.invoiceNumber ? `invoice ${movement.invoiceNumber}` : movement.billReference ? `bill ${movement.billReference}` : "entered in Livestock", movement.amount ? `$${movement.amount}` : ""].filter(Boolean).join(" · "),
              })),
            ]}
            value={answers.movementId ?? (index > 0 ? "__new" : null)}
            onPick={(value) => {
              const movement = movements.find((entry) => entry.id === value);
              if (movement) {
                set({ movementId: movement.id, head: String(movement.head), day: movement.movementDate, amount: "" });
                setLinkedOnly(true);
                setIndex(1);
              } else {
                set({ movementId: null });
                setLinkedOnly(false);
                next();
              }
            }}
          />
          <p className={ui.muted}>A sale or purchase is only counted once: link the movement made from its invoice or bill.</p>
        </Step>
      );
    }
    case "kind":
      return (
        <Step {...frame} question="What kind of stock?">
          <Choices options={LIVESTOCK_KINDS.map((kind) => ({ value: kind, label: KIND_NAMES[kind] }))} value={answers.kind} onPick={(kind) => (set({ kind, classCode: "" }), next())} />
        </Step>
      );
    case "class":
      return (
        <Step {...frame} question="Which class?">
          <Choices options={classesOf(answers.kind).map((entry) => ({ value: entry.code, label: entry.name }))} value={answers.classCode || null} onPick={(classCode) => (set({ classCode }), next())} />
          <p className={ui.muted}>
            IRD&apos;s class, as at balance date. <InfoTip label="Classes">The books count livestock by these classes for tax. A mob is one class: split a mixed mob into one mob for each class.</InfoTip>
          </p>
        </Step>
      );
    case "toClass":
      return (
        <Step {...frame} question={`What class is ${mob!.name} now?`}>
          <Choices options={classesOf(mob!.kind).filter((entry) => entry.code !== mob!.classCode).map((entry) => ({ value: entry.code, label: entry.name }))} value={answers.toClassCode || null} onPick={(toClassCode) => (set({ toClassCode }), next())} />
        </Step>
      );
    case "head":
      return (
        <Step {...frame} question={flow.kind === "add" ? "How many head?" : (QUESTION[flow.action] ?? "How many?")} onNext={next} nextDisabled={!headOk}>
          <BigNumber value={answers.head} onChange={(head) => set({ head })} label="Head" unit="head" />
          {mob ? <p className={ui.muted}>{mob.name} has {mob.head.toLocaleString("en-NZ")} now.</p> : null}
        </Step>
      );
    case "how":
      return (
        <Step {...frame} question="How did they come?">
          <Choices
            options={CREATED_HOW.filter((how) => how !== "born" || isBirthClass(answers.kind, answers.classCode)).map((how) => ({
              value: how,
              label: CREATED_HOW_LABELS[how],
              note: how === "on_farm" ? "Counted already; the books don't change" : "Changes the books' head count",
            }))}
            value={answers.how}
            onPick={(how) => (set({ how }), next())}
          />
        </Step>
      );
    case "paddock":
    case "paddockOptional":
      return (
        <Step
          {...frame}
          question={step === "paddock" ? `Where is ${mob?.name ?? "it"} going?` : flow.kind === "add" ? "Which paddock are they in?" : "Which paddock does the new mob go to?"}
          onSkip={step === "paddockOptional" ? () => (set({ paddockId: null }), next()) : undefined}
        >
          <Choices
            options={[
              ...paddocks
                .filter((entry) => entry.paddockId !== mob?.paddock?.id || step === "paddockOptional")
                .map((entry) => ({
                  value: entry.paddockId,
                  label: entry.name,
                  note: [entry.notSafeUntil ? `not safe to graze until ${shortDate(entry.notSafeUntil.until, today)}` : null, entry.inNow ? `${entry.inNow.mob} in` : entry.lastGrazedOn ? `grazed ${daysAgo(entry.lastGrazedOn, today)}` : "not grazed yet"].filter(Boolean).join(" · "),
                })),
              ...(step === "paddock" && mob?.paddock ? [{ value: "__out", label: "Off the paddock", note: "yards, road or another place" }] : []),
            ]}
            value={answers.paddockId}
            onPick={(paddockId) => (set({ paddockId: paddockId === "__out" ? null : paddockId }), next())}
          />
          {statuses.error ? <Notice tone="warning">{statuses.error}</Notice> : null}
        </Step>
      );
    case "name":
      return (
        <Step {...frame} question={flow.kind === "add" ? "A name and tag colour?" : "A name for the new mob?"} onNext={next} onSkip={() => (set({ name: "", tagColour: "" }), next())}>
          <Field label="Name">
            <input value={answers.name} maxLength={100} placeholder="e.g. Two-tooths" onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="Tag colour">
            <input value={answers.tagColour} maxLength={30} placeholder="e.g. Blue" onChange={(event) => set({ tagColour: event.target.value })} />
          </Field>
        </Step>
      );
    case "averageKg":
      return (
        <Step {...frame} question="Average weight?" onNext={next} nextDisabled={!/^\d{1,4}(\.\d)?$/.test(answers.averageKg)}>
          <BigNumber value={answers.averageKg} onChange={(averageKg) => set({ averageKg })} label="Average liveweight" unit="kg" />
        </Step>
      );
    case "weighedHead":
      return (
        <Step {...frame} question="How many were weighed?" onNext={next} onSkip={() => (set({ weighedHead: "" }), next())} nextDisabled={answers.weighedHead !== "" && !/^\d{1,6}$/.test(answers.weighedHead)}>
          <BigNumber value={answers.weighedHead} onChange={(weighedHead) => set({ weighedHead })} label="Head weighed" unit="head" />
        </Step>
      );
    case "amount":
      return (
        <Step {...frame} question={flow.kind === "action" && flow.action === "sell" ? "What did they sell for?" : "What did they cost?"} onNext={next} onSkip={() => (set({ amount: "" }), next())} nextDisabled={answers.amount !== "" && !/^\d+(\.\d{1,2})?$/.test(answers.amount.replace(/,/g, ""))}>
          <BigNumber value={answers.amount} onChange={(amount) => set({ amount: amount.replace(/,/g, "") })} label="Total, excluding GST" unit="$" />
          <p className={ui.muted}>Optional. The invoice or bill is still how the money is recorded.</p>
        </Step>
      );
    case "into": {
      const others = mobs.filter((entry) => entry.id !== mob!.id && entry.kind === mob!.kind && entry.classCode === mob!.classCode);
      return (
        <Step {...frame} question={`Merge ${mob!.name} into which mob?`}>
          {!others.length ? <p>No other mob of {mob!.className.toLowerCase()} on {farm.name}. Change a mob&apos;s class first.</p> : null}
          <Choices options={others.map((entry) => ({ value: entry.id, label: entry.name, note: `${entry.head} head${entry.paddock ? ` in ${entry.paddock.name}` : ""}` }))} value={answers.intoMobId} onPick={(intoMobId) => (set({ intoMobId }), next())} />
        </Step>
      );
    }
    case "day":
      return (
        <Step {...frame} question="Which day?" onNext={next}>
          <DayChoice value={answers.day} onChange={(day) => set({ day })} />
        </Step>
      );
    default: {
      const lines: Array<[string, string]> = [];
      if (flow.kind === "add") {
        lines.push(["Class", `${KIND_NAMES[answers.kind]}: ${className(answers.kind, answers.classCode)}`], ["Head", answers.head], ["How", CREATED_HOW_LABELS[answers.how]], ["Paddock", paddockName(answers.paddockId) ?? "None"], ["Name", answers.name.trim() || "None (the class is its name)"]);
      } else {
        lines.push(["Mob", `${mob!.name} (${mob!.head} head)`]);
        if (flow.action === "move") lines.push(["From", mob!.paddock?.name ?? "Not in a paddock"], ["To", paddockName(answers.paddockId) ?? "Off the paddock"]);
        if (flow.action === "weigh") lines.push(["Average", `${answers.averageKg} kg`], ["Weighed", answers.weighedHead || "Not said"]);
        if (["deaths", "births", "count", "sell", "buy", "split"].includes(flow.action)) lines.push([flow.action === "count" ? "Head now" : "Head", answers.head]);
        if ((flow.action === "sell" || flow.action === "buy") && answers.amount) lines.push(["Amount excl. GST", `$${answers.amount}`]);
        if (answers.movementId) lines.push(["Books", "Linked to the livestock movement chosen"]);
        if (flow.action === "split") lines.push(["New mob", answers.name.trim() || mob!.className], ["Goes to", paddockName(answers.paddockId) ?? mob!.paddock?.name ?? "Not in a paddock"]);
        if (flow.action === "merge") lines.push(["Into", mobs.find((entry) => entry.id === answers.intoMobId)?.name ?? "–"]);
        if (flow.action === "reclass") lines.push(["New class", className(mob!.kind, answers.toClassCode)]);
      }
      lines.push(["Day", formatDate(answers.day)]);
      const target = flow.kind === "action" && flow.action === "move" ? paddocks.find((entry) => entry.paddockId === answers.paddockId) : null;
      return (
        <Step {...frame} question="Check and save" onNext={() => void save()} nextLabel={busy ? "Saving…" : "Save"} nextDisabled={busy}>
          {errorNote}
          <dl className={styles.facts}>
            {lines.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {target?.inNow ? <Notice tone="info">{target.inNow.mob} is in {target.name} already. Both mobs will be there.</Notice> : null}
          {target?.notSafeUntil ? <Notice tone="warning">{target.name} was sprayed{target.notSafeUntil.product ? ` with ${target.notSafeUntil.product}` : ""} and isn&apos;t safe to graze until {formatDate(target.notSafeUntil.until)}. You can still save the move.</Notice> : null}
          {flow.kind === "action" && flow.action === "sell" && withheld(mob!.withholding, answers.day).meat ? <Notice tone="warning">{mob!.name} isn&apos;t safe for slaughter until {formatDate(mob!.withholding!.meatSafeOn!)}. Check where they&apos;re going before you send them.</Notice> : null}
          {books ? <Notice tone="info">This changes the books&apos; livestock head count too, when Livestock is on.</Notice> : null}
          {flow.kind === "action" && flow.action === "count" ? <Notice tone="warning">A count changes the mob only. If stock died, was sold or was born, record that instead so the books match.</Notice> : null}
        </Step>
      );
    }
  }
}
