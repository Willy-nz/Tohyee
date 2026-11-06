"use client";

import Link from "next/link";
import { useState } from "react";
import { BcsPanel, ScalesCard } from "@/components/farm-bcs";
import { BigNumber, Choices, DayChoice, Step } from "@/components/farm-log";
import { FarmRowList } from "@/components/farm-rows";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { MoreMenu } from "@/components/more-menu";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { AnimalImportPreview, RecordImportPreview } from "@/lib/farming/animal-import";
import type { AnimalDetail } from "@/lib/farming/animal-detail";
import { ageText, ANIMAL_SEXES, type AnimalSex, HOW_IN_LABELS, HOW_OUT_LABELS, SEX_LABELS, STATUS_LABELS } from "@/lib/farming/animal-rules";
import type { Animal } from "@/lib/farming/animals";
import { gainText, paddockLabel } from "@/lib/farming/mob-rules";
import type { Mob } from "@/lib/farming/mobs";
import { shortDate } from "@/lib/farming/farm-words";
import { formatDate, todayInBrowser } from "@/lib/format";
import { KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * The animal register (decisions 1481-1486): a list to search, each
 * animal's page, adding animals in steps, and importing animals and their
 * scores and weights. A mob's head stays the one count: tagging changes no
 * head, and sales and deaths of tagged animals are recorded on the mob.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

export function animalLine(animal: Animal, today: string): string[] {
  return [
    animal.kindName,
    animal.status !== "on_farm" ? STATUS_LABELS[animal.status] : "",
    animal.mob ? animal.mob.name : "Not in a mob",
    animal.lastWeight ? `${animal.lastWeight.kg} kg ${shortDate(animal.lastWeight.date, today)}` : "",
    animal.lastBcs ? `BCS ${animal.lastBcs.score} ${shortDate(animal.lastBcs.date, today)}` : "",
    animal.eid ? `EID ${animal.eid}` : "",
  ].filter(Boolean);
}

export function FarmAnimals({ organisationId, farm, initialAnimal }: FarmContext & { initialAnimal?: string | null }) {
  const today = todayInBrowser();
  const { can } = useWorkspace();
  const canRecord = useCanRecordFarmWork();
  const [q, setQ] = useState("");
  const [mobId, setMobId] = useState("");
  const [gone, setGone] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialAnimal ?? null);
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const animals = useApiData<{ animals: Animal[] }>(`/api/farming/farms/${farm.id}/animals`, { organisationId, includeGone: gone ? "1" : undefined, mobId: mobId || undefined, q: q.trim() || undefined });
  const mobs = useApiData<{ mobs: Mob[] }>(`/api/farming/farms/${farm.id}/mobs`, { organisationId });
  const list = [...(animals.data?.animals ?? [])].sort((a, b) => NATURAL.compare(a.tag, b.tag));
  if (adding) {
    return (
      <AddAnimalFlow
        organisationId={organisationId}
        farm={farm}
        mobs={mobs.data?.mobs ?? []}
        onClose={(message, id) => {
          setAdding(false);
          if (message) setDone(message);
          if (id) setSelected(id);
          animals.reload();
          mobs.reload();
        }}
      />
    );
  }
  return (
    <div className={styles.grid}>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        {done ? <Notice tone="success">{done}</Notice> : null}
        <Card
          title="Animals"
          actions={
            canRecord ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link className={`${ui.button} ${ui.secondary}`} href={`/operations/farm/animals/quick?farm=${farm.id}`}>
                  Quick entry
                </Link>
                <Button onClick={() => (setDone(null), setAdding(true))}>Add an animal</Button>
              </div>
            ) : null
          }
        >
          <p className={ui.muted} style={{ marginTop: 0 }}>
            Animals with their own tag.{" "}
            <InfoTip label="Animals and mobs">
              A mob&apos;s head is the one count. Tagging an animal into a mob doesn&apos;t change the mob&apos;s head or the books. Record sales and deaths on the mob, and choose the tags that went.
            </InfoTip>
          </p>
          <div className={ui.inlineForm}>
            <Field label="Tag or EID">
              <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="e.g. 214" />
            </Field>
            <Field label="Mob">
              <select value={mobId} onChange={(event) => setMobId(event.target.value)}>
                <option value="">All mobs</option>
                {(mobs.data?.mobs ?? []).map((mob) => (
                  <option key={mob.id} value={mob.id}>
                    {mob.name}
                  </option>
                ))}
              </select>
            </Field>
            <label className={styles.check}>
              <input type="checkbox" checked={gone} onChange={(event) => setGone(event.target.checked)} /> Sold and dead too
            </label>
          </div>
          {animals.error ? <Notice tone="error">{animals.error}</Notice> : null}
          {!animals.data && !animals.error ? <p className={ui.muted}>Loading…</p> : null}
          {animals.data && !list.length ? <p>{q || mobId ? "No animals match." : "No animals yet. Add one, or import a file."}</p> : null}
          {list.length ? (
            <>
              <p className={ui.muted}>
                {list.length.toLocaleString("en-NZ")} animal{list.length === 1 ? "" : "s"}
                {list.length >= 20000 ? " (the first 20,000)" : ""}.
              </p>
              <FarmRowList
                label="Animals"
                rows={list.slice(0, 500).map((animal) => ({
                  key: animal.id,
                  title: animal.tag,
                  parts: animalLine(animal, today),
                  onOpen: () => {
                    setSelected(animal.id);
                    requestAnimationFrame(() => document.getElementById("animal-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                  },
                }))}
              />
              {list.length > 500 ? <p className={ui.muted}>Showing the first 500. Search by tag to find others.</p> : null}
            </>
          ) : null}
        </Card>
        <div id="animal-card" style={{ scrollMarginTop: 64 }}>
          {selected ? (
            <AnimalCard
              key={selected}
              organisationId={organisationId}
              farm={farm}
              animalId={selected}
              mobs={mobs.data?.mobs ?? []}
              onChanged={() => {
                animals.reload();
                mobs.reload();
              }}
              onOpen={setSelected}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </div>
      </div>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <ScalesCard organisationId={organisationId} farmId={farm.id} />
        {can("bookkeeper") ? <ImportCard organisationId={organisationId} farmId={farm.id} onImported={() => (animals.reload(), mobs.reload())} /> : null}
      </div>
    </div>
  );
}

type CardMode = null | "weight" | "move" | "place" | "edit";

function AnimalCard({ organisationId, farm, animalId, mobs, onChanged, onOpen, onClose }: { organisationId: string; farm: FarmContext["farm"]; animalId: string; mobs: Mob[]; onChanged: () => void; onOpen: (id: string) => void; onClose: () => void }) {
  const today = todayInBrowser();
  const canRecord = useCanRecordFarmWork();
  const detail = useApiData<AnimalDetail>(`/api/farming/animals/${animalId}`, { organisationId });
  const [mode, setMode] = useState<CardMode>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    detail.reload();
    onChanged();
  };
  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <p className={ui.muted}>Loading…</p>;
  const { animal } = detail.data;
  const here = animal.status === "on_farm" || animal.status === "missing";
  const act = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const result = await api<{ message: string }>(`/api/farming/animals/${animal.id}/actions`, { method: "POST", body: { organisationId, ...body } });
      setMessage(result.message);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const parent = (link: { id: string; tag: string } | null, text: string | null) =>
    link ? (
      <button type="button" className={ui.linkButton} onClick={() => onOpen(link.id)}>
        {link.tag}
      </button>
    ) : (
      (text ?? "Not recorded")
    );
  return (
    <Card title={`${animal.tag}${animal.status !== "on_farm" ? ` (${STATUS_LABELS[animal.status].toLowerCase()})` : ""}`} description={`${animal.kindName} · ${farm.name}`} actions={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {animal.status === "missing" ? <Notice tone="warning">Missing since {animal.statusOn ? formatDate(animal.statusOn) : "–"}. Still counted in its mob until a death, sale or count is recorded.</Notice> : null}
      <dl className={styles.facts}>
        <dt>Mob</dt>
        <dd>{animal.mob ? <Link href={`/operations/farm/mobs?farm=${farm.id}`}>{animal.mob.name}</Link> : "Not in a mob"}{animal.mob ? `, since ${shortDate(animal.mob.since, today)}` : ""}</dd>
        <dt>EID or NAIT</dt>
        <dd>
          {animal.eid ?? "Not recorded"} <InfoTip label="EID">Kept here only. Nothing is sent to NAIT from Tohyee.</InfoTip>
        </dd>
        <dt>Sex</dt>
        <dd>{animal.sex ? SEX_LABELS[animal.sex] : "Not recorded"}</dd>
        <dt>Breed</dt>
        <dd>{animal.breed ?? "Not recorded"}</dd>
        <dt>Born</dt>
        <dd>{animal.birthOn ? `${formatDate(animal.birthOn)} (${ageText(animal.birthOn, today) ?? "–"})` : "Not recorded"}</dd>
        <dt>Dam</dt>
        <dd>{parent(animal.dam, animal.damText)}</dd>
        <dt>Sire</dt>
        <dd>{parent(animal.sire, animal.sireText)}</dd>
        <dt>Weight</dt>
        <dd>{animal.lastWeight ? `${animal.lastWeight.kg} kg on ${shortDate(animal.lastWeight.date, today)}${animal.lastWeight.gain ? `, ${gainText(animal.lastWeight.gain)}` : ""}` : "Not weighed yet"}</dd>
      </dl>
      {canRecord && here && !mode ? (
        <>
          <div className={styles.bigButtons} role="group" aria-label={`Actions for ${animal.tag}`}>
            <button type="button" className={styles.bigButton} onClick={() => setMode("weight")}>
              Record a weight
            </button>
            {animal.mob ? (
              <button type="button" className={styles.bigButton} onClick={() => setMode("move")}>
                Move to another mob
              </button>
            ) : (
              <button type="button" className={styles.bigButton} onClick={() => setMode("place")}>
                Put in a mob
              </button>
            )}
          </div>
          <div className={styles.actions}>
            <MoreMenu
              label={`More for ${animal.tag}`}
              text="More"
              items={[
                { label: "Change details", onSelect: () => setMode("edit") },
                ...(animal.mob ? [{ label: "Correct its mob (no head changes)", onSelect: () => setMode("place") }] : []),
                animal.status === "missing" ? { label: "Found", onSelect: () => void act({ action: "found" }) } : { label: "Mark missing", onSelect: () => void act({ action: "missing", onDate: today }) },
              ]}
            />
          </div>
          <p className={ui.muted}>
            Sold or died? Record it on {animal.mob ? <Link href={`/operations/farm/mobs?farm=${farm.id}`}>{animal.mob.name}</Link> : "its mob"} and choose {animal.tag}, so the head count stays right.
          </p>
        </>
      ) : null}
      {mode === "weight" ? <WeightForm organisationId={organisationId} farm={farm} animal={animal} onClose={(text) => (setMode(null), text && setMessage(text), reload())} /> : null}
      {mode === "move" || mode === "place" ? <MobForm organisationId={organisationId} animal={animal} mobs={mobs} move={mode === "move"} onClose={(text) => (setMode(null), text && setMessage(text), reload())} /> : null}
      {mode === "edit" ? <EditForm organisationId={organisationId} animal={animal} onClose={(text) => (setMode(null), text && setMessage(text), reload())} /> : null}

      <BcsPanel
        organisationId={organisationId}
        subject={{ animalId: animal.id, name: animal.tag, farm }}
        records={detail.data.bcs}
        trend={[...detail.data.bcs].filter((record) => record.scale === detail.data!.scale).reverse().map((record) => ({ date: record.scoredOn, score: record.score }))}
        scale={detail.data.scale as "1_10" | "1_5"}
        targets={detail.data.targets}
        photos={detail.data.photos}
        suggestions={detail.data.suggestions}
        onChanged={reload}
      />

      <h3>Weights</h3>
      {detail.data.weights.length ? (
        <FarmRowList label={`${animal.tag} weights`} rows={detail.data.weights.slice(0, 30).map((weight) => ({ key: weight.id, title: shortDate(weight.date, today), parts: [`${weight.kg} kg`, weight.gain ? gainText(weight.gain) : "", weight.mobEventId ? "in a mob weigh session" : "", weight.source === "ai_suggestion" ? "estimated from a photo" : weight.source === "import" ? "imported" : ""] }))} />
      ) : (
        <p className={ui.muted}>None yet.</p>
      )}

      <h3>Treatments</h3>
      {detail.data.treatments.length ? (
        <FarmRowList
          label={`${animal.tag} treatments`}
          rows={detail.data.treatments.slice(0, 30).map((treatment) => ({ key: treatment.id, title: shortDate(treatment.treatedOn, today), parts: [treatment.product, treatment.dose, treatment.how === "tag" ? "by its tag" : `to ${treatment.mobName ?? "its mob"}`, treatment.meatSafeOn ? `safe for slaughter from ${shortDate(treatment.meatSafeOn, today)}` : ""] }))}
        />
      ) : (
        <p className={ui.muted}>None found by its tag or its mob.</p>
      )}

      {detail.data.breeding.length ? (
        <>
          <h3>Mating, AI and scanning (its mob)</h3>
          <FarmRowList label={`${animal.tag} breeding`} rows={detail.data.breeding.slice(0, 20).map((record) => ({ key: record.id, title: shortDate(record.onDate, today), parts: [record.recordType === "ai" ? "AI" : record.recordType === "joining" ? "Mating" : record.recordType === "scanning" ? "Scanning" : "Pregnancy test", record.sire ?? "", record.mobName, record.scanningPercent ? `${record.scanningPercent}%` : record.inCalfPercent ? `${record.inCalfPercent}% in calf` : ""] }))} />
          <p className={ui.muted}>These are the mob&apos;s records while {animal.tag} was in it, not this animal&apos;s own result.</p>
        </>
      ) : null}

      <h3>Mobs and moves</h3>
      {detail.data.mobs.length ? (
        <FarmRowList
          label={`${animal.tag} mobs`}
          rows={detail.data.mobs.map((spell, index) => ({ key: `${spell.mobId}-${spell.fromOn}-${index}`, title: shortDate(spell.fromOn, today), parts: [`${HOW_IN_LABELS[spell.howIn] ?? "In"} ${spell.mobName}`, spell.toOn ? `${HOW_OUT_LABELS[spell.howOut ?? ""] ?? "out"} ${shortDate(spell.toOn, today)}` : "now"] }))}
        />
      ) : (
        <p className={ui.muted}>Not in a mob yet.</p>
      )}
      {detail.data.moves.length ? <FarmRowList label={`${animal.tag} paddock moves`} rows={detail.data.moves.slice(0, 15).map((move, index) => ({ key: `${move.date}-${index}`, title: shortDate(move.date, today), parts: [move.mobName, move.to ? `to ${paddockLabel(move.to)}` : `out of ${move.from ?? "the paddock"}`] }))} /> : null}
      {detail.data.offspring.length ? (
        <>
          <h3>Offspring</h3>
          <p>
            {detail.data.offspring.map((child, index) => (
              <span key={child.id}>
                {index ? ", " : ""}
                <button type="button" className={ui.linkButton} onClick={() => onOpen(child.id)}>
                  {child.tag}
                </button>
              </span>
            ))}
          </p>
        </>
      ) : null}
    </Card>
  );
}

function WeightForm({ organisationId, farm, animal, onClose }: { organisationId: string; farm: FarmContext["farm"]; animal: Animal; onClose: (message: string | null) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [kg, setKg] = useState("");
  const [day, setDay] = useState(todayInBrowser());
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const operationId = newOperationId();
      const outcome = await submitThroughQueue(queue, { operationId, kind: "animal.readings", label: `Weight: ${animal.tag}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: `/api/farming/animals/${animal.id}/actions`, body: { action: "readings", farmId: farm.id, kg, onDate: day, source: "typed" } } });
      onClose(outcome.state === "synced" ? ((outcome.result as { message?: string } | undefined)?.message ?? "Saved.") : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title={`Weight · ${animal.tag}`}>
      {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
      <BigNumber value={kg} onChange={setKg} label="Liveweight" unit="kg" />
      <DayChoice value={day} onChange={setDay} />
      <div className={styles.actions}>
        <Button disabled={!/^\d{1,4}(\.\d)?$/.test(kg)} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="secondary" onClick={() => onClose(null)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function MobForm({ organisationId, animal, mobs, move, onClose }: { organisationId: string; animal: Animal; mobs: Mob[]; move: boolean; onClose: (message: string | null) => void }) {
  const [mobId, setMobId] = useState<string | null>(null);
  const [day, setDay] = useState(todayInBrowser());
  const [error, setError] = useState<string | null>(null);
  const current = mobs.find((mob) => mob.id === animal.mob?.id);
  const options = mobs.filter((mob) => mob.kind === animal.kind && mob.id !== animal.mob?.id && (move ? mob.classCode === current?.classCode : mob.tagged < mob.head));
  const save = async () => {
    setError(null);
    try {
      const result = move
        ? await api<{ message: string }>("/api/farming/animals/move", { method: "POST", body: { organisationId, animalIds: [animal.id], toMobId: mobId, onDate: day, operationId: newOperationId() } })
        : await api<{ message: string }>(`/api/farming/animals/${animal.id}/actions`, { method: "POST", body: { organisationId, action: "place", mobId: mobId === "__none" ? null : mobId, onDate: day } });
      onClose(result.message);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title={move ? `Move ${animal.tag} to another mob` : animal.mob ? `Correct ${animal.tag}'s mob` : `Put ${animal.tag} in a mob`}>
      {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
      <p className={ui.muted}>
        {move
          ? `${animal.tag} goes with its head: ${animal.mob?.name ?? "its mob"} has one fewer and the new mob one more. Only mobs of the same class are offered, so the books don't change.`
          : "No head changes: this only says which mob it's in. Only mobs with more head than tagged animals are offered."}
      </p>
      {!options.length ? <p>No mob to offer. {move ? "Change a mob's class, or add a mob, first." : "Record more head on a mob first (bought, born or a count)."}</p> : null}
      <Choices
        options={[...options.map((mob) => ({ value: mob.id, label: mob.name, note: `${mob.head} head, ${mob.tagged} tagged` })), ...(!move && animal.mob ? [{ value: "__none", label: "Not in a mob", note: "takes it out of " + animal.mob.name }] : [])]}
        value={mobId}
        onPick={setMobId}
      />
      <DayChoice value={day} onChange={setDay} />
      <div className={styles.actions}>
        <Button disabled={!mobId} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="secondary" onClick={() => onClose(null)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function EditForm({ organisationId, animal, onClose }: { organisationId: string; animal: Animal; onClose: (message: string | null) => void }) {
  const [form, setForm] = useState({ tag: animal.tag, eid: animal.eid ?? "", sex: animal.sex ?? "", breed: animal.breed ?? "", birthOn: animal.birthOn ?? "", dam: animal.dam?.tag ?? animal.damText ?? "", sire: animal.sire?.tag ?? animal.sireText ?? "", note: animal.note ?? "" });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const save = async () => {
    setError(null);
    try {
      await api(`/api/farming/animals/${animal.id}`, { method: "PATCH", body: { organisationId, tag: form.tag, eid: form.eid || null, sex: form.sex || null, breed: form.breed || null, birthOn: form.birthOn || null, damText: form.dam || null, sireText: form.sire || null, note: form.note || null } });
      onClose("Details saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title={`Change details · ${animal.tag}`}>
      {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
      <DetailsFields form={form} set={set} />
      <Field label="Note">
        <input value={form.note} maxLength={500} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <div className={styles.actions}>
        <Button disabled={!form.tag.trim()} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="secondary" onClick={() => onClose(null)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

type Details = { tag: string; eid: string; sex: string; breed: string; birthOn: string; dam: string; sire: string };

function DetailsFields({ form, set, only }: { form: Details; set: (patch: Partial<Details>) => void; only?: "tag" | "about" | "parents" }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!only || only === "tag" ? (
        <>
          <Field label="Visual tag">
            <input value={form.tag} maxLength={30} autoFocus={only === "tag"} onChange={(event) => set({ tag: event.target.value })} placeholder="e.g. 214 or YB 214" />
          </Field>
          <Field label="EID or NAIT number (optional)">
            <input value={form.eid} maxLength={30} onChange={(event) => set({ eid: event.target.value })} placeholder="e.g. 982 000123456789" />
          </Field>
        </>
      ) : null}
      {!only || only === "about" ? (
        <>
          <Field label="Sex">
            <select value={form.sex} onChange={(event) => set({ sex: event.target.value })}>
              <option value="">Not recorded</option>
              {ANIMAL_SEXES.map((sex) => (
                <option key={sex} value={sex}>
                  {SEX_LABELS[sex as AnimalSex]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Breed">
            <input value={form.breed} maxLength={60} onChange={(event) => set({ breed: event.target.value })} placeholder="e.g. Friesian" />
          </Field>
          <Field label="Birth date">
            <input type="date" value={form.birthOn} max={todayInBrowser()} onChange={(event) => set({ birthOn: event.target.value })} />
          </Field>
        </>
      ) : null}
      {!only || only === "parents" ? (
        <>
          <Field label="Dam's tag">
            <input value={form.dam} maxLength={60} onChange={(event) => set({ dam: event.target.value })} placeholder="a tag on the farm, or as known" />
          </Field>
          <Field label="Sire (tag, name or AI bull code)">
            <input value={form.sire} maxLength={60} onChange={(event) => set({ sire: event.target.value })} />
          </Field>
          <p className={ui.muted} style={{ margin: 0 }}>
            A tag that matches one animal on the farm is linked to it. Anything else is kept as typed.
          </p>
        </>
      ) : null}
    </div>
  );
}

function AddAnimalFlow({ organisationId, farm, mobs, onClose }: { organisationId: string; farm: FarmContext["farm"]; mobs: Mob[]; onClose: (message: string | null, id?: string) => void }) {
  const steps = ["kind", "tag", "mob", "about", "parents", "review"] as const;
  const [index, setIndex] = useState(0);
  const [kind, setKind] = useState<LivestockKind>("dairy_cattle");
  const [mobId, setMobId] = useState<string | null>(null);
  const [form, setForm] = useState<Details>({ tag: "", eid: "", sex: "", breed: "", birthOn: "", dam: "", sire: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Details>) => setForm((current) => ({ ...current, ...patch }));
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const frame = { title: `Add an animal · ${farm.name}`, step: index + 1, steps: steps.length, onBack: () => (index === 0 ? onClose(null) : setIndex((value) => value - 1)) };
  const options = mobs.filter((mob) => mob.kind === kind);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ animal: Animal }>(`/api/farming/farms/${farm.id}/animals`, {
        method: "POST",
        body: { organisationId, operationId: newOperationId(), kind, tag: form.tag.trim(), eid: form.eid.trim() || null, sex: form.sex || null, breed: form.breed.trim() || null, birthOn: form.birthOn || null, damText: form.dam.trim() || null, sireText: form.sire.trim() || null, mobId },
      });
      onClose(`${result.animal.tag} added${result.animal.mob ? ` to ${result.animal.mob.name}` : ""}.`, result.animal.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  switch (steps[index]) {
    case "kind":
      return (
        <Step {...frame} question="What kind of stock?">
          <Choices options={LIVESTOCK_KINDS.map((value) => ({ value, label: KIND_NAMES[value] }))} value={kind} onPick={(value) => (setKind(value), setMobId(null), next())} />
        </Step>
      );
    case "tag":
      return (
        <Step {...frame} question="What's on its tag?" onNext={next} nextDisabled={!form.tag.trim()}>
          <DetailsFields form={form} set={set} only="tag" />
        </Step>
      );
    case "mob":
      return (
        <Step {...frame} question="Which mob is it in?" onSkip={() => (setMobId(null), next())}>
          <p className={ui.muted} style={{ margin: 0 }}>
            Tagging it into a mob doesn&apos;t change the mob&apos;s head. A mob with every head tagged isn&apos;t offered.{" "}
            <InfoTip label="Room in a mob">If this animal is new to the farm, record it on the mob first (bought or born), then tag it.</InfoTip>
          </p>
          {!options.length ? <p>No {KIND_NAMES[kind].toLowerCase()} mobs on {farm.name}. Skip, or add a mob first.</p> : null}
          <Choices options={options.map((mob) => ({ value: mob.id, label: mob.name, note: mob.tagged >= mob.head ? `all ${mob.head} head tagged` : `${mob.head} head, ${mob.tagged} tagged` }))} value={mobId} onPick={(value) => (setMobId(value), next())} />
        </Step>
      );
    case "about":
      return (
        <Step {...frame} question="Sex, breed and birth date?" onNext={next} onSkip={next}>
          <DetailsFields form={form} set={set} only="about" />
        </Step>
      );
    case "parents":
      return (
        <Step {...frame} question="Dam and sire?" onNext={next} onSkip={next}>
          <DetailsFields form={form} set={set} only="parents" />
        </Step>
      );
    default: {
      const mob = mobs.find((entry) => entry.id === mobId);
      const lines: Array<[string, string]> = [
        ["Kind", KIND_NAMES[kind]],
        ["Tag", form.tag],
        ["EID", form.eid || "None"],
        ["Mob", mob ? mob.name : "Not in a mob"],
        ["Sex", form.sex ? SEX_LABELS[form.sex as AnimalSex] : "Not recorded"],
        ["Breed", form.breed || "Not recorded"],
        ["Born", form.birthOn ? formatDate(form.birthOn) : "Not recorded"],
        ["Dam", form.dam || "Not recorded"],
        ["Sire", form.sire || "Not recorded"],
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
          {mob ? <Notice tone="info">{mob.name} keeps {mob.head} head. The books don&apos;t change.</Notice> : null}
        </Step>
      );
    }
  }
}

function ImportCard({ organisationId, farmId, onImported }: { organisationId: string; farmId: string; onImported: () => void }) {
  const [what, setWhat] = useState<"animals" | "records">("animals");
  const [kind, setKind] = useState<string>("");
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [animals, setAnimals] = useState<AnimalImportPreview | null>(null);
  const [records, setRecords] = useState<RecordImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const path = `/api/farming/farms/${farmId}/animals/import`;
  const send = <T,>(preview: boolean) => api<T>(path, { method: "POST", body: { organisationId, what, kind: kind || null, fileName: file?.name, content: file?.content, contentBase64: file?.contentBase64, preview } });
  const pick = async (picked: File | undefined) => {
    setAnimals(null);
    setRecords(null);
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
  const preview = what === "animals" ? animals : records;
  const reset = () => {
    setAnimals(null);
    setRecords(null);
    setFile(null);
    setPicker((value) => value + 1);
  };
  return (
    <Card title="Import animals, scores and weights">
      <details>
        <summary className={ui.linkButton}>Import a file</summary>
        <Choices
          options={[
            { value: "animals", label: "Animals", note: "tag, EID, sex, breed, birth date, dam, mob" },
            { value: "records", label: "Scores and weights", note: "by tag and date, from a scale or another tool" },
          ]}
          value={what}
          onPick={(value) => (setWhat(value), reset())}
        />
        <p className={ui.muted}>
          {what === "animals" ? "A row per animal. A kind column, a mob, or the kind below says what stock it is." : "A row per tag (or EID) and date, with a BCS or weight column, or both. Scores from another BCS tool load in this way."}{" "}
          <InfoTip label="Nothing made silently">
            {what === "animals"
              ? "Animals are tagged into their mob, which keeps its head. A mob with every head tagged can't take more. Nothing is saved until you import."
              : "A tag that isn't on the register is listed and skipped. Add the animal first, then import again. Nothing is saved until you import."}
          </InfoTip>
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          {what === "animals" ? (
            <Field label="Kind, if the file doesn't say">
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="">From the file or mob</option>
                {LIVESTOCK_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KIND_NAMES[value]}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="File">
            <input key={picker} type="file" accept=".csv,.xlsx,text/csv" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button
            variant="secondary"
            disabled={!file}
            onClick={() =>
              void run(async () => {
                if (what === "animals") setAnimals((await send<{ preview: AnimalImportPreview }>(true)).preview);
                else setRecords((await send<{ preview: RecordImportPreview }>(true)).preview);
              })
            }
          >
            Preview
          </Button>
        </div>
        {preview ? (
          <>
            {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
            {animals ? (
              <p>
                {animals.counts.animals} animal{animals.counts.animals === 1 ? "" : "s"} to import{animals.counts.errors ? `, ${animals.counts.errors} skipped` : ""}.{animals.counts.damsTyped ? ` ${animals.counts.damsTyped} dam tags aren't on the register and will be kept as typed.` : ""}
              </p>
            ) : null}
            {records ? (
              <>
                <p>
                  {records.counts.scores} score{records.counts.scores === 1 ? "" : "s"} and {records.counts.weights} weight{records.counts.weights === 1 ? "" : "s"} to import{records.counts.errors ? `, ${records.counts.errors} rows skipped` : ""}.
                </p>
                {records.unmatched.length ? (
                  <Notice tone="warning">
                    Not on the register (skipped, nothing added): {records.unmatched.slice(0, 50).join(", ")}
                    {records.unmatched.length > 50 ? ` and ${records.unmatched.length - 50} more` : ""}.
                  </Notice>
                ) : null}
              </>
            ) : null}
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Tag</th>
                    <th>{animals ? "Mob" : "Date"}</th>
                    <th>{animals ? "Dam" : "BCS · kg"}</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {animals
                    ? animals.rows.slice(0, 200).map((row) => (
                        <tr key={row.line}>
                          <td data-label="Line">{row.line}</td>
                          <td data-label="Tag">{row.tag ?? "–"}</td>
                          <td data-label="Mob">{row.mobName ?? "–"}</td>
                          <td data-label="Dam">{row.dam ? `${row.dam}${row.damFound ? "" : " (typed)"}` : "–"}</td>
                          <td data-label="Problem">{row.error ? <Badge tone="red">{row.error}</Badge> : ""}</td>
                        </tr>
                      ))
                    : records!.rows.slice(0, 200).map((row) => (
                        <tr key={row.line}>
                          <td data-label="Line">{row.line}</td>
                          <td data-label="Tag">{row.tag ?? "–"}</td>
                          <td data-label="Date">{row.date ?? "–"}</td>
                          <td data-label="BCS · kg">{[row.score ? `BCS ${row.score}` : "", row.kg ? `${row.kg} kg` : ""].filter(Boolean).join(" · ") || "–"}</td>
                          <td data-label="Problem">{row.error ? <Badge tone="red">{row.error}</Badge> : ""}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            <Button
              disabled={Boolean(preview.alreadyImportedOn) || (animals ? !animals.counts.animals : !records!.counts.scores && !records!.counts.weights)}
              onClick={() =>
                void run(async () => {
                  if (what === "animals") {
                    const result = await send<{ imported: number; skipped: number }>(false);
                    setDone(`Imported ${result.imported} animal${result.imported === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} skipped` : ""}.`);
                  } else {
                    const result = await send<{ scores: number; weights: number; skipped: number }>(false);
                    setDone(`Imported ${result.scores} scores and ${result.weights} weights${result.skipped ? `; ${result.skipped} rows skipped` : ""}.`);
                  }
                  reset();
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
