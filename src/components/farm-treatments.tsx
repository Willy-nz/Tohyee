"use client";

import { useState } from "react";
import { BigNumber, Choices, DayChoice, Step } from "@/components/farm-log";
import { FarmRowList } from "@/components/farm-rows";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { DateInput } from "@/components/date-input";
import { api, errorMessage } from "@/lib/client/api";
import { shortDate } from "@/lib/farming/farm-words";
import type { Mob } from "@/lib/farming/mobs";
import { isPositiveQuantity, LABEL_NOTE, meatSafeOn, milkBasisText, milkSafeFrom, parseTimeGiven, safeText, STOCK_UNITS, type StockUnit, timeText } from "@/lib/farming/treatment-rules";
import type { ProductStock, SprayWithholding, Treatment } from "@/lib/farming/treatments";
import { formatDate, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import type { ChemicalData, CurrentRecord } from "@/lib/safety/shared";
import styles from "./farm-workspace.module.css";

/*
 * Treatments and withholding on the farm (decisions 1431-1438): treating a
 * mob as one-question steps (kept on the device when there's no signal),
 * the treatment register and stock movement exports, product stock from
 * Safety's chemical register, and a spray job's grazing withholding.
 */

type Answers = { givenTime: string; product: string; chemicalRecordId: string | null; dose: string; quantity: string; unit: StockUnit; meat: string; milk: string; givenBy: string; batch: string; reason: string; head: string; animals: string; day: string };

const STEPS = ["product", "dose", "head", "withholding", "givenBy", "extra", "day", "review"] as const;

/** Treating a mob (TRT1-TRT2), one question a screen. */
export function TreatFlow({ organisationId, farm, mob, onClose }: Pick<FarmContext, "organisationId" | "farm"> & { mob: Mob; onClose: (message: string | null) => void }) {
  const today = todayInBrowser();
  const { user } = useWorkspace();
  const { queue } = useOfflineQueue(organisationId);
  const chemicals = useApiData<{ chemicals: Array<CurrentRecord<ChemicalData>> }>("/api/farming/safety/chemicals", { organisationId, farmId: farm.id });
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({ givenTime: "", product: "", chemicalRecordId: null, dose: "", quantity: "", unit: "mL", meat: "", milk: "", givenBy: user.displayName || user.email, batch: "", reason: "", head: String(mob.head), animals: "", day: today });
  const set = (patch: Partial<Answers>) => setAnswers((current) => ({ ...current, ...patch }));
  const step = STEPS[index];
  const next = () => setIndex((value) => Math.min(value + 1, STEPS.length - 1));
  const back = () => (index === 0 ? onClose(null) : setIndex((value) => value - 1));
  const frame = { title: `Treat · ${mob.name}`, step: index + 1, steps: STEPS.length, onBack: back };
  const products = (chemicals.data?.chemicals ?? []).filter((record) => !record.data.removed);
  const whole = (text: string) => text === "" || /^\d{1,5}$/.test(text);
  const head = Number(answers.head);

  const save = async () => {
    setBusy(true);
    setError(null);
    const operationId = newOperationId();
    const body = {
      farmId: farm.id,
      mobId: mob.id,
      head: answers.head,
      animals: head < mob.head ? answers.animals.trim() || null : null,
      treatedOn: answers.day,
      givenTime: answers.givenTime || null,
      product: answers.product.trim() || null,
      chemicalRecordId: answers.chemicalRecordId,
      dose: answers.dose.trim(),
      quantity: answers.quantity || null,
      quantityUnit: answers.quantity ? answers.unit : null,
      meatWithholdingDays: answers.meat === "" ? null : answers.meat,
      milkWithholdingHours: answers.milk === "" ? null : answers.milk,
      givenBy: answers.givenBy.trim(),
      batch: answers.batch.trim() || null,
      reason: answers.reason.trim() || null,
    };
    try {
      const outcome = await submitThroughQueue(queue, { operationId, kind: "farm.treatment", label: `Treatment: ${mob.name}, ${answers.product || "product"}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: `/api/farming/farms/${farm.id}/treatments`, body } });
      onClose(outcome.state === "synced" ? ((outcome.result as { message?: string } | undefined)?.message ?? "Treatment recorded.") : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  switch (step) {
    case "product":
      return (
        <Step {...frame} question="Which product?" onNext={next} nextDisabled={!answers.product.trim() && !answers.chemicalRecordId}>
          {products.length ? (
            <Choices
              options={products.map((record) => ({ value: record.recordId, label: record.data.name, note: record.data.location ?? undefined }))}
              value={answers.chemicalRecordId}
              onPick={(chemicalRecordId) => (set({ chemicalRecordId, product: products.find((record) => record.recordId === chemicalRecordId)?.data.name ?? "" }), next())}
            />
          ) : null}
          <Field label={products.length ? "Or another product" : "Product"}>
            <input value={answers.chemicalRecordId ? "" : answers.product} maxLength={150} placeholder="e.g. a drench, pour-on or vaccine" onChange={(event) => set({ product: event.target.value, chemicalRecordId: null })} />
          </Field>
          <p className={ui.muted}>
            Products in Safety&apos;s chemical register keep their stock on hand. <InfoTip label="Products">Add animal remedies to the chemical register in Safety to track how much is left. A product typed here is kept on the treatment only.</InfoTip>
          </p>
        </Step>
      );
    case "dose":
      return (
        <Step {...frame} question="What dose, and how much was used?" onNext={next} nextDisabled={!answers.dose.trim() || (answers.quantity !== "" && !isPositiveQuantity(answers.quantity))}>
          <Field label="Dose">
            <input value={answers.dose} maxLength={100} placeholder="e.g. 10 mL per head" onChange={(event) => set({ dose: event.target.value })} />
          </Field>
          <div className={ui.inlineForm}>
            <Field label="Quantity used">
              <input inputMode="decimal" value={answers.quantity} onChange={(event) => set({ quantity: event.target.value.replace(/,/g, "") })} />
            </Field>
            <Field label="Unit">
              <select value={answers.unit} onChange={(event) => set({ unit: event.target.value as StockUnit })}>
                {STOCK_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Step>
      );
    case "head":
      return (
        <Step {...frame} question="How many were treated?" onNext={next} nextDisabled={!/^\d{1,6}$/.test(answers.head) || head < 1 || head > mob.head || (head < mob.head && !answers.animals.trim())}>
          <BigNumber value={answers.head} onChange={(value) => set({ head: value })} label="Head" unit="head" />
          {head > 0 && head < mob.head ? (
            <Field label="Which animals (tags)">
              <input value={answers.animals} maxLength={500} placeholder="e.g. tags 104, 117, 230" onChange={(event) => set({ animals: event.target.value })} />
            </Field>
          ) : null}
          <p className={ui.muted}>{mob.name} has {mob.head.toLocaleString("en-NZ")}.</p>
        </Step>
      );
    case "withholding":
      return (
        <Step {...frame} question="Withholding on the label?" onNext={next} nextDisabled={!whole(answers.meat) || !whole(answers.milk)}>
          <Notice tone="info">{LABEL_NOTE} Enter 0 for nil. Leave blank only if the label doesn&apos;t give one.</Notice>
          <div className={ui.inlineForm}>
            <Field label="Meat (days)">
              <input inputMode="numeric" value={answers.meat} onChange={(event) => set({ meat: event.target.value })} />
            </Field>
            <Field label="Milk (hours)">
              <input inputMode="numeric" value={answers.milk} onChange={(event) => set({ milk: event.target.value })} />
            </Field>
          </div>
          <p className={ui.muted}>
            Milk is in hours, as most labels give it. <InfoTip label="Milk withholding">The time of treatment isn&apos;t kept, so the hours are counted from the end of the treatment day. A label in milkings: count 12 hours a milking for twice-a-day milking.</InfoTip>
          </p>
        </Step>
      );
    case "givenBy":
      return (
        <Step {...frame} question="Who gave it?" onNext={next} nextDisabled={!answers.givenBy.trim()}>
          <Field label="Name">
            <input value={answers.givenBy} maxLength={100} onChange={(event) => set({ givenBy: event.target.value })} />
          </Field>
        </Step>
      );
    case "extra":
      return (
        <Step {...frame} question="Batch and reason?" onNext={next} onSkip={() => (set({ batch: "", reason: "" }), next())}>
          <Field label="Batch number">
            <input value={answers.batch} maxLength={60} onChange={(event) => set({ batch: event.target.value })} />
          </Field>
          <Field label="Reason">
            <input value={answers.reason} maxLength={200} placeholder="e.g. pre-tupping drench" onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </Step>
      );
    case "day":
      return (
        <Step {...frame} question="Which day, and what time?" onNext={next} nextDisabled={parseTimeGiven(answers.givenTime) === undefined}>
          <DayChoice value={answers.day} onChange={(day) => set({ day })} />
          <Field label="Time given (if you know it)">
            <input type="time" value={answers.givenTime} onChange={(event) => set({ givenTime: event.target.value })} />
          </Field>
          <p className={ui.muted}>
            With the time, milk withholding counts from it exactly. <InfoTip label="Time given">Without a time, the hours count from the end of the day, to be safe. The time is the farm&apos;s local time.</InfoTip>
          </p>
        </Step>
      );
    default: {
      const meat = meatSafeOn(answers.day, answers.meat === "" ? null : Number(answers.meat));
      const givenTime = parseTimeGiven(answers.givenTime) ?? null;
      const milk = milkSafeFrom(answers.day, answers.milk === "" ? null : Number(answers.milk), givenTime);
      const lines: Array<[string, string]> = [
        ["Mob", head < mob.head ? `${head} of ${mob.name}: ${answers.animals}` : `${mob.name} (${mob.head})`],
        ["Product", answers.product],
        ["Dose", answers.dose],
        ["Used", answers.quantity ? `${answers.quantity} ${answers.unit}` : "Not recorded"],
        ["Safe for slaughter from", meat ? formatDate(meat) : "No meat withholding entered"],
        ["Milk safe from", milk ? `${safeText(milk, formatDate)} (${milkBasisText(givenTime)})` : "No milk withholding entered"],
        ["Given by", answers.givenBy],
        ["Day", `${formatDate(answers.day)}${givenTime ? `, ${timeText(givenTime)}` : ""}`],
      ];
      return (
        <Step {...frame} question="Check and save" onNext={() => void save()} nextLabel={busy ? "Saving…" : "Save"} nextDisabled={busy}>
          {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
          <dl className={styles.facts}>
            {lines.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className={ui.muted}>{LABEL_NOTE}</p>
        </Step>
      );
    }
  }
}

/** The register and the audit exports (TRT6). */
export function TreatmentsCard({ organisationId, farmId, version }: { organisationId: string; farmId: string; version: number }) {
  const today = todayInBrowser();
  const [from, setFrom] = useState(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`);
  const [to, setTo] = useState(today);
  const treatments = useApiData<{ treatments: Treatment[] }>(`/api/farming/farms/${farmId}/treatments`, { organisationId, version });
  const list = treatments.data?.treatments ?? [];
  const href = (path: string, format: "csv" | "pdf") => `/api/farming/farms/${farmId}/${path}?format=${format}&from=${from}&to=${to}&organisationId=${encodeURIComponent(organisationId)}`;
  return (
    <Card
      title="Treatments"
      description={
        <>
          The latest treatments. <InfoTip label="Treatment register">{LABEL_NOTE} The register and the stock movement history download for farm assurance and processor audits.</InfoTip>
        </>
      }
    >
      {treatments.error ? <Notice tone="error">{treatments.error}</Notice> : null}
      {list.length ? (
        <FarmRowList
          label="Treatments"
          rows={list.slice(0, 8).map((t) => ({
            key: t.id,
            title: shortDate(t.treatedOn, today),
            parts: [t.mobName ?? t.animals ?? "", t.product, `${t.head} head`, t.meatSafeOn && t.meatSafeOn > today ? `meat ${shortDate(t.meatSafeOn, today)}` : "", t.milkSafeFrom && t.milkSafeFrom > today ? `milk ${safeText(t.milkSafeFrom, (iso) => shortDate(iso, today))} (${milkBasisText(t.givenTime)})` : ""],
            details: (
              <p>
                {t.dose}
                {t.quantity ? `, ${t.quantity} ${t.quantityUnit} used` : ""}
                {t.batch ? `, batch ${t.batch}` : ""}. Given by {t.givenBy}.{t.reason ? ` ${t.reason}.` : ""}
              </p>
            ),
          }))}
        />
      ) : (
        <p className={ui.muted}>{treatments.data ? "No treatments yet. Treat a mob from its card." : "Loading…"}</p>
      )}
      <h3>Download</h3>
      <div className={ui.inlineForm}>
        <Field label="From">
          <DateInput value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="To">
          <DateInput value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
      </div>
      <div className={styles.actions}>
        <a className={ui.linkButton} href={href("treatments/export", "pdf")} download>
          Treatment register (PDF)
        </a>
        <a className={ui.linkButton} href={href("treatments/export", "csv")} download>
          CSV
        </a>
        <a className={ui.linkButton} href={href("stock-movements", "pdf")} download>
          Stock movements (PDF)
        </a>
        <a className={ui.linkButton} href={href("stock-movements", "csv")} download>
          CSV
        </a>
      </div>
    </Card>
  );
}

/** Product stock on hand from Safety's chemical register (TRT7-TRT8). */
export function ProductStockCard({ organisationId, farmId, version }: { organisationId: string; farmId: string; version: number }) {
  const canRecord = useCanRecordFarmWork();
  const stock = useApiData<{ products: ProductStock[] }>("/api/farming/product-stock", { organisationId, farmId, version });
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ movementType: "received" as "received" | "counted" | "disposed", quantity: "", unit: "L" as StockUnit, batch: "", movedOn: todayInBrowser() });
  const [error, setError] = useState<string | null>(null);
  const products = stock.data?.products ?? [];
  const save = async (product: ProductStock) => {
    setError(null);
    try {
      await api("/api/farming/product-stock", { method: "POST", body: { organisationId, chemicalRecordId: product.chemicalRecordId, ...form, batch: form.batch || null } });
      setOpen(null);
      setForm({ ...form, quantity: "", batch: "" });
      stock.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Animal health and chemical stock"
      description={
        <>
          From Safety&apos;s chemical register. <InfoTip label="Product stock">On hand is the last count, plus what came in, less what treatments and spray jobs say they used and what was thrown out. mL and g are counted as L and kg.</InfoTip>
        </>
      }
    >
      {stock.error ? <Notice tone="error">{stock.error}</Notice> : null}
      {stock.data && !products.length ? <p>No products in the chemical register yet. Add them in Safety.</p> : null}
      {products.length ? (
        <FarmRowList
          label="Product stock"
          rows={products.map((product) => ({
            key: product.chemicalRecordId,
            title: product.name,
            parts: [product.onHand === null ? "No stock recorded" : `${product.onHand} ${product.unit ?? ""} on hand`, product.lastCountedOn ? `counted ${formatDate(product.lastCountedOn)}` : "", product.notCounted.length ? `${product.notCounted.length} uses in other units` : ""],
            details: (
              <div style={{ display: "grid", gap: 8 }}>
                {open === product.chemicalRecordId ? (
                  <>
                    {error ? <Notice tone="error">{error}</Notice> : null}
                    <Choices
                      options={[
                        { value: "received", label: "Received" },
                        { value: "counted", label: "Counted" },
                        { value: "disposed", label: "Thrown out" },
                      ]}
                      value={form.movementType}
                      onPick={(movementType) => setForm({ ...form, movementType })}
                    />
                    <div className={ui.inlineForm}>
                      <Field label={form.movementType === "counted" ? "How much is there" : "How much"}>
                        <input inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
                      </Field>
                      <Field label="Unit">
                        <select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as StockUnit })}>
                          {STOCK_UNITS.map((unit) => (
                            <option key={unit}>{unit}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Batch">
                        <input value={form.batch} maxLength={60} onChange={(event) => setForm({ ...form, batch: event.target.value })} />
                      </Field>
                      <Field label="Date">
                        <DateInput value={form.movedOn} onChange={(event) => setForm({ ...form, movedOn: event.target.value })} />
                      </Field>
                    </div>
                    <Button disabled={!/^\d+(\.\d{1,3})?$/.test(form.quantity)} onClick={() => void save(product)}>
                      Save
                    </Button>
                  </>
                ) : null}
                {product.history.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {product.history.slice(0, 8).map((entry, index) => (
                      <li key={index}>
                        {formatDate(entry.date)}: {entry.text}, {entry.kind === "treatment" || entry.kind === "spray" || entry.kind === "disposed" ? "−" : ""}
                        {entry.quantity} {entry.unit}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ),
            actions: canRecord && open !== product.chemicalRecordId ? (
              <Button variant="secondary" onClick={() => (setOpen(product.chemicalRecordId), setForm({ ...form, unit: (STOCK_UNITS as readonly string[]).includes(product.unit ?? "") ? (product.unit as StockUnit) : "L" }))}>
                Record stock
              </Button>
            ) : undefined,
          }))}
        />
      ) : null}
    </Card>
  );
}

/** A spray job's grazing withholding (TRT5), on the tractor job's page. */
export function SprayWithholdingCard({ organisationId, jobId, canEdit }: { organisationId: string; jobId: string; canEdit: boolean }) {
  const loaded = useApiData<{ withholding: SprayWithholding | null }>(`/api/farming/tractor/jobs/${jobId}/withholding`, { organisationId });
  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = loaded.data?.withholding ?? null;
  const value = days ?? (current ? String(current.days) : "");
  const save = async () => {
    setError(null);
    try {
      await api(`/api/farming/tractor/jobs/${jobId}/withholding`, { method: "PUT", body: { organisationId, days: value === "" ? null : value } });
      setDays(null);
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="Grazing withholding">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {current ? <Notice tone="warning">The job&apos;s paddocks aren&apos;t safe to graze until {formatDate(current.safeOn)}.</Notice> : <p>No grazing withholding entered for this spray job.</p>}
      <p className={ui.muted}>{LABEL_NOTE} It counts from the day spraying finished.</p>
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Days, from the label">
            <input inputMode="numeric" value={value} onChange={(event) => setDays(event.target.value)} />
          </Field>
          <Button variant="secondary" disabled={value !== "" && !/^\d{1,3}$/.test(value)} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
