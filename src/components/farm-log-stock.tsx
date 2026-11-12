"use client";

import { useState } from "react";
import { operationId, useFarmDrafts } from "@/components/farm-drafts";
import { BigNumber, Choices, DayChoice, StatusBadge, Step } from "@/components/farm-log";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { addDraft, type DraftKind } from "@/lib/farming/drafts";
import { shortDate } from "@/lib/farming/farm-words";
import type { Mob } from "@/lib/farming/mobs";
import { isBirthClass, paddockLabel } from "@/lib/farming/mob-rules";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import { todayInBrowser } from "@/lib/format";
import styles from "./farm-workspace.module.css";

/*
 * #447 item 10 (decision 1598): the rest of the Log sheet. A mob moved,
 * births or deaths, and a treatment, one question a screen, saved on the
 * phone first and sent with its own operation id like every quick log.
 * They go through the same mob actions and treatment register as the Mobs
 * and Treatments screens, with the same checks: a mob on another farm is
 * refused, and anything that needs the books (selling, buying) stays there.
 */

export type StockFlowKind = "move" | "births" | "deaths" | "treatment";

const TITLES: Record<StockFlowKind, string> = { move: "Move a mob", births: "Births", deaths: "Deaths", treatment: "Treatment" };

const STEPS: Record<StockFlowKind, string[]> = {
  move: ["mob", "paddock", "day", "review"],
  births: ["mob", "head", "day", "review"],
  deaths: ["mob", "head", "day", "note", "review"],
  treatment: ["mob", "product", "dose", "head", "withholding", "givenBy", "day", "review"],
};

type Answers = { mobId: string | null; paddockId: string | null; head: string; day: string; note: string; product: string; dose: string; meat: string; milk: string; givenBy: string };

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });
const whole = (text: string, max: number) => (/^\d+$/.test(text) && Number(text) >= 0 && Number(text) <= max ? Number(text) : null);

export function StockLog({ organisationId, farm, kind, onClose }: FarmContext & { kind: StockFlowKind; onClose: () => void }) {
  const today = todayInBrowser();
  const { store, change, sync, stored } = useFarmDrafts(organisationId);
  const mobs = useApiData<{ mobs: Mob[] }>(`/api/farming/farms/${farm.id}/mobs`, { organisationId });
  const statuses = useApiData<{ paddocks: PaddockStatus[] }>(kind === "move" ? `/api/farming/farms/${farm.id}/paddock-status` : null, { organisationId, onDate: today });
  const steps = STEPS[kind];
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({ mobId: null, paddockId: null, head: "", day: today, note: "", product: "", dose: "", meat: "", milk: "", givenBy: "" });
  const set = (patch: Partial<Answers>) => setAnswers((current) => ({ ...current, ...patch }));
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => (index === 0 ? onClose() : setIndex((value) => value - 1));
  const frame = { title: `${TITLES[kind]} · ${farm.name}`, step: index + 1, steps: steps.length, onBack: back };

  if (mobs.error) return <Notice tone="error">{mobs.error}</Notice>;
  if (!mobs.data) return <p className={ui.muted}>Loading…</p>;
  const active = mobs.data.mobs.filter((mob) => mob.status === "active" && (kind !== "births" || isBirthClass(mob.kind, mob.classCode))).sort((a, b) => NATURAL.compare(a.name, b.name));
  const mob = active.find((entry) => entry.id === answers.mobId) ?? null;
  const paddocks = (statuses.data?.paddocks ?? []).filter((status) => status.paddockId !== mob?.paddock?.id).sort((a, b) => NATURAL.compare(a.name, b.name));
  const to = paddocks.find((status) => status.paddockId === answers.paddockId) ?? null;
  const head = whole(answers.head, 100000);

  if (saved) {
    const draft = store.drafts.find((entry) => entry.operationId === saved);
    return (
      <Card title={`${TITLES[kind]} recorded`}>
        <p>
          {draft?.label} {draft ? <StatusBadge status={draft.status} stored={stored} /> : null}
        </p>
        {draft?.error ? <Notice tone="warning">{draft.error}</Notice> : null}
        <div className={styles.actions}>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Card>
    );
  }

  const describe = (): { kind: DraftKind; payload: Record<string, unknown>; label: string } => {
    const when = shortDate(answers.day, today);
    if (kind === "move") return { kind: "mob_action", payload: { mobId: mob!.id, action: "move", toPaddockId: to!.paddockId, onDate: answers.day }, label: `${mob!.name} to ${paddockLabel(to!.name)}, ${when}` };
    if (kind === "births") return { kind: "mob_action", payload: { mobId: mob!.id, action: "births", head, onDate: answers.day }, label: `${head} born into ${mob!.name}, ${when}` };
    if (kind === "deaths") {
      return { kind: "mob_action", payload: { mobId: mob!.id, action: "deaths", head, onDate: answers.day, note: answers.note.trim() || null }, label: `${head} died from ${mob!.name}, ${when}` };
    }
    return {
      kind: "treatment",
      payload: {
        mobId: mob!.id,
        head,
        treatedOn: answers.day,
        product: answers.product.trim(),
        dose: answers.dose.trim(),
        meatWithholdingDays: answers.meat === "" ? null : Number(answers.meat),
        milkWithholdingHours: answers.milk === "" ? null : Number(answers.milk),
        givenBy: answers.givenBy.trim(),
      },
      label: `${mob!.name} (${head}) treated with ${answers.product.trim()}, ${when}`,
    };
  };

  const save = () => {
    const id = operationId();
    const draft = describe();
    change((current) => addDraft(current, { operationId: id, farmId: farm.id, farmName: farm.name, createdAt: new Date().toISOString(), walkId: null, paddockId: null, ...draft }));
    setSaved(id);
    void sync();
  };

  switch (steps[index]) {
    case "mob":
      return (
        <Step {...frame} question={kind === "move" ? "Which mob is moving?" : kind === "treatment" ? "Which mob was treated?" : kind === "births" ? "Born into which mob?" : "From which mob?"}>
          {!active.length ? (
            <p>{kind === "births" ? `No mob on ${farm.name} is a class that has births (the rising one-year classes: calves, lambs, fawns and the like).` : `No mob is set up on ${farm.name}. Add one under Mobs.`}</p>
          ) : null}
          <Choices
            options={active.map((entry) => ({ value: entry.id, label: entry.name, note: `${entry.head} head${entry.paddock ? ` · in ${paddockLabel(entry.paddock.name)}` : ""}` }))}
            value={answers.mobId}
            onPick={(mobId) => {
              const picked = active.find((entry) => entry.id === mobId);
              set({ mobId, head: kind === "treatment" && picked ? String(picked.head) : answers.head });
              next();
            }}
          />
        </Step>
      );
    case "paddock":
      return (
        <Step {...frame} question={`Where is ${mob?.name ?? "the mob"} going?`}>
          {statuses.error ? <Notice tone="error">{statuses.error}</Notice> : null}
          <Choices
            options={paddocks.map((status) => ({
              value: status.paddockId,
              label: paddockLabel(status.name),
              note: [status.inNow ? `${status.inNow.mob} in` : "", status.notSafeUntil ? `not safe to graze until ${shortDate(status.notSafeUntil.until, today)}` : ""].filter(Boolean).join(" · "),
            }))}
            value={answers.paddockId}
            onPick={(paddockId) => {
              set({ paddockId });
              next();
            }}
          />
        </Step>
      );
    case "head": {
      const max = kind === "births" ? 100000 : mob?.head ?? 0;
      const ok = head !== null && head > 0 && head <= max;
      return (
        <Step {...frame} question={kind === "births" ? "How many were born?" : kind === "deaths" ? "How many died?" : "How many were treated?"} onNext={next} nextDisabled={!ok}>
          <BigNumber value={answers.head} onChange={(text) => set({ head: text })} label="Head" unit="head" />
          {answers.head !== "" && !ok ? <p role="alert">{kind === "births" ? "A whole number, 1 or more." : `A whole number from 1 to ${max} (${mob?.name} has ${mob?.head}).`}</p> : null}
          {kind === "deaths" && mob && mob.tagged > 0 ? <p className={ui.muted}>{mob.name} has tagged animals. If tagged ones died, record them on the mob&apos;s page so the register stays right.</p> : null}
        </Step>
      );
    }
    case "day":
      return (
        <Step {...frame} question="When?" onNext={next}>
          <DayChoice value={answers.day} onChange={(day) => set({ day })} />
        </Step>
      );
    case "note":
      return (
        <Step {...frame} question="Anything to note? (cause, tag numbers)" onNext={next} onSkip={() => (set({ note: "" }), next())}>
          <Field label="Note">
            <input value={answers.note} maxLength={500} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </Step>
      );
    case "product":
      return (
        <Step {...frame} question="Which product?" onNext={next} nextDisabled={!answers.product.trim()}>
          <Field label="Product, as on the label">
            <input value={answers.product} maxLength={150} onChange={(event) => set({ product: event.target.value })} />
          </Field>
        </Step>
      );
    case "dose":
      return (
        <Step {...frame} question="What dose?" onNext={next} nextDisabled={!answers.dose.trim()}>
          <Field label="Dose, e.g. 10 mL each">
            <input value={answers.dose} maxLength={100} onChange={(event) => set({ dose: event.target.value })} />
          </Field>
        </Step>
      );
    case "withholding": {
      const meatOk = answers.meat === "" || whole(answers.meat, 1000) !== null;
      const milkOk = answers.milk === "" || whole(answers.milk, 24000) !== null;
      return (
        <Step {...frame} question="Withholding, as on the label?" onNext={next} nextDisabled={!meatOk || !milkOk}>
          <Field label="Meat (days)">
            <input inputMode="numeric" value={answers.meat} onChange={(event) => set({ meat: event.target.value.replace(/[^0-9]/g, "") })} />
          </Field>
          <Field label="Milk (hours)">
            <input inputMode="numeric" value={answers.milk} onChange={(event) => set({ milk: event.target.value.replace(/[^0-9]/g, "") })} />
          </Field>
          <p className={ui.muted}>Leave blank if the label has none. Tohyee works out the safe dates from what you type; it doesn&apos;t look them up.</p>
        </Step>
      );
    }
    case "givenBy":
      return (
        <Step {...frame} question="Who gave it?" onNext={next} nextDisabled={!answers.givenBy.trim()}>
          <Field label="Name">
            <input value={answers.givenBy} maxLength={100} onChange={(event) => set({ givenBy: event.target.value })} />
          </Field>
        </Step>
      );
    default: {
      const draft = mob && (kind !== "move" || to) && (kind === "move" || head) ? describe() : null;
      return (
        <Step {...frame} question="Check and save" onNext={save} nextLabel="Save" nextDisabled={!draft}>
          <p>{draft?.label}</p>
          {kind === "treatment" ? (
            <p className={ui.muted}>
              Dose {answers.dose.trim()}; withholding {answers.meat ? `meat ${answers.meat} days` : "no meat"}, {answers.milk ? `milk ${answers.milk} hours` : "no milk"}; given by {answers.givenBy.trim()}.
            </p>
          ) : null}
          <p className={ui.muted}>Saved on this phone first, and sent when there&apos;s signal.</p>
        </Step>
      );
    }
  }
}
