"use client";

import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { newOperationId } from "@/components/farm-safety";
import { useApiData } from "@/components/hooks";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime } from "@/lib/format";
import { recordAnchor } from "@/lib/safety/screens";
import type { InductionToRead, InductionView, SignoffView, SiteLink } from "@/lib/safety/inductions";
import { type Audience, AUDIENCE_LABELS, AUDIENCES, type CurrentRecord, HAZARD_LEVEL_LABELS, INVITE_CONTRACTORS, NOT_COMPETENCE, SELF_DECLARED, SIGN_STATEMENT, SIGNED_HOW_LABELS, type VisitData } from "@/lib/safety/shared";

/*
 * Inductions, sign-offs, signing in on site and the farm's sign-in link,
 * on the Safety page (#446, decisions 948-952).
 */

type Data = { inductions: InductionView[]; signoffs: SignoffView[]; onSite: { here: Array<CurrentRecord<VisitData>>; leftToday: Array<CurrentRecord<VisitData>> }; links: SiteLink[]; canRecord: boolean };

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const whoText = (person: { name: string; company: string | null }) => (person.company ? `${person.name} (${person.company})` : person.name);

/**
 * People and inductions (decision 983): signing in and your own inductions
 * first, then, for those who keep the registers, who has signed, the
 * induction templates and the farm's sign-in link.
 */
export function InductionsAndSignIn({ organisationId, farm, openInduction = null, after = null }: { organisationId: string; farm: Farm; openInduction?: string | null; after?: React.ReactNode }) {
  const data = useApiData<Data>("/api/farming/safety/inductions", { organisationId, farmId: farm.id });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading inductions…</p>;
  return (
    <>
      <OnSiteCard organisationId={organisationId} farm={farm} data={data.data} onChanged={data.reload} />
      <InductionsCard organisationId={organisationId} farm={farm} data={data.data} onChanged={data.reload} part="mine" openInduction={openInduction} />
      {after}
      {data.data.canRecord ? (
        <>
          <h2 style={{ fontSize: "var(--text-lg)", margin: "8px 0 0" }}>For managers</h2>
          <InductionsCard organisationId={organisationId} farm={farm} data={data.data} onChanged={data.reload} part="manage" openInduction={null} />
          <SiteLinkCard organisationId={organisationId} farm={farm} links={data.data.links} onChanged={data.reload} />
        </>
      ) : null}
    </>
  );
}

// On site -----------------------------------------------------------------------------------------------

function OnSiteCard({ organisationId, farm, data, onChanged }: { organisationId: string; farm: Farm; data: Data; onChanged: () => void }) {
  const [adding, setAdding] = useState<"me" | "someone" | null>(null);
  const [person, setPerson] = useState({ name: "", company: "", phone: "", audience: "visitor" as Audience, purpose: "" });
  const [fixing, setFixing] = useState<string | null>(null);
  const [fix, setFix] = useState({ leftAt: "", why: "" });
  const [operationId, setOperationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const done = () => {
    setAdding(null);
    setFixing(null);
    setOperationId(newOperationId());
    onChanged();
  };
  return (
    <Card
      title={`On site now (${data.onSite.here.length})`}
      description="Who has signed in and not out. It's what people reported, not where their phone is: check the time it was last updated."
      actions={
        <>
          <Button size="small" variant="secondary" onClick={() => setAdding(adding === "me" ? null : "me")}>
            Sign me in
          </Button>
          {data.canRecord ? (
            <Button size="small" variant="secondary" onClick={() => setAdding(adding === "someone" ? null : "someone")}>
              Sign someone in
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api("/api/farming/safety/visits", { method: "POST", body: { organisationId, farmId: farm.id, operationId, purpose: person.purpose, ...(adding === "someone" ? { person: { name: person.name, company: person.company, phone: person.phone }, audience: person.audience } : {}) } }), done);
          }}
          style={{ marginBottom: 8 }}
        >
          {adding === "someone" ? (
            <div className={ui.inlineForm}>
              <Field label="Name">
                <input value={person.name} required maxLength={150} onChange={(event) => setPerson({ ...person, name: event.target.value })} />
              </Field>
              <Field label="Company">
                <input value={person.company} maxLength={150} onChange={(event) => setPerson({ ...person, company: event.target.value })} />
              </Field>
              <Field label="Phone">
                <input type="tel" value={person.phone} maxLength={40} onChange={(event) => setPerson({ ...person, phone: event.target.value })} />
              </Field>
              <Field label="They're a">
                <select value={person.audience} onChange={(event) => setPerson({ ...person, audience: event.target.value as Audience })}>
                  <option value="visitor">Visitor</option>
                  <option value="contractor">Contractor</option>
                  <option value="worker">Worker</option>
                </select>
              </Field>
            </div>
          ) : null}
          <Field label="What for">
            <input value={person.purpose} maxLength={300} onChange={(event) => setPerson({ ...person, purpose: event.target.value })} />
          </Field>
          <Button type="submit" disabled={busy || (adding === "someone" && !person.name.trim())}>
            Sign in
          </Button>
        </form>
      ) : null}
      {!data.onSite.here.length ? <Empty>Nobody is signed in on {farm.name}.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {data.onSite.here.map((visit) => (
          <li key={visit.recordId} id={recordAnchor("visit", visit.recordId)} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", scrollMarginTop: 72 }}>
            <strong>{whoText(visit.data.person)}</strong> <Badge>{AUDIENCE_LABELS[visit.data.audience].replace(/s$/, "")}</Badge>
            {visit.data.signedHow === "link" ? <> <Badge>{SELF_DECLARED}</Badge></> : null}
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              Signed in {formatDateTime(visit.firstEnteredAt)}
              {visit.data.purpose ? ` · ${visit.data.purpose}` : ""} · {SIGNED_HOW_LABELS[visit.data.signedHow]}
              {visit.happenedOn && visit.happenedOn < new Date().toISOString().slice(0, 10) ? " · still signed in from an earlier day" : ""}
            </div>
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void run(() => api(`/api/farming/safety/visits/${visit.recordId}`, { method: "POST", body: { organisationId } }), done)}>
                Sign out now
              </Button>
              {data.canRecord ? (
                <Button size="small" variant="secondary" onClick={() => setFixing(fixing === visit.recordId ? null : visit.recordId)}>
                  They left earlier…
                </Button>
              ) : null}
            </div>
            {fixing === visit.recordId ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => api(`/api/farming/safety/visits/${visit.recordId}`, { method: "POST", body: { organisationId, leftAt: new Date(fix.leftAt).toISOString(), why: fix.why } }), done);
                }}
              >
                <div className={ui.inlineForm}>
                  <Field label="When they left">
                    <input type="datetime-local" required value={fix.leftAt} onChange={(event) => setFix({ ...fix, leftAt: event.target.value })} />
                  </Field>
                  <Field label="Why it's corrected">
                    <input required maxLength={1000} value={fix.why} onChange={(event) => setFix({ ...fix, why: event.target.value })} placeholder="e.g. forgot to sign out" />
                  </Field>
                  <Button type="submit" disabled={busy || !fix.leftAt || !fix.why.trim()}>
                    Save
                  </Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {data.onSite.leftToday.length ? (
        <p className={ui.muted}>
          Left today:{" "}
          {data.onSite.leftToday
            .map((visit) => `${whoText(visit.data.person)} (${visit.data.leftAt ? `left ${formatDateTime(visit.data.leftAt)}, corrected later` : `signed out ${formatDateTime(visit.enteredAt)}`})`)
            .join("; ")}
        </p>
      ) : null}
    </Card>
  );
}

// Inductions ---------------------------------------------------------------------------------------------

function InductionsCard({ organisationId, farm, data, onChanged, part, openInduction }: { organisationId: string; farm: Farm; data: Data; onChanged: () => void; part: "mine" | "manage"; openInduction: string | null }) {
  const [reading, setReading] = useState<{ id: string; forSomeone: boolean } | null>(openInduction ? { id: openInduction, forSomeone: false } : null);
  const [editing, setEditing] = useState<InductionView | "new" | null>(null);
  const live = data.inductions.filter((induction) => induction.change !== "withdrawn");
  const needAgain = data.signoffs.filter((signoff) => !signoff.current);
  const manage = part === "manage";
  const { user } = useWorkspace();
  const mine = (inductionId: string) => data.signoffs.find((signoff) => signoff.data.inductionId === inductionId && signoff.data.person.userId === user.id) ?? null;
  return (
    <Card
      title={manage ? "Inductions and who has signed" : "Your inductions"}
      description={manage ? "Add or change inductions, record a sign-off for someone, and see who has signed. Each sign-off keeps the version and hazards they saw." : "Read this farm's induction, with its hazards and emergency details, and sign it on your own login."}
      actions={
        manage && !editing ? (
          <Button size="small" variant="secondary" onClick={() => setEditing("new")}>
            Add an induction
          </Button>
        ) : null
      }
    >
      {editing ? <InductionForm organisationId={organisationId} farm={farm} current={editing === "new" ? null : editing} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} /> : null}
      {!live.length && !editing ? <Empty>{manage ? "No inductions yet. Add one for workers, contractors and visitors; this farm's hazards and emergency details go with it." : `No induction for ${farm.name} yet.`}</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {live.map((induction) => (
          <li key={induction.recordId} id={manage ? undefined : recordAnchor("induction", induction.recordId)} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", scrollMarginTop: 72 }}>
            <strong>{induction.data.title}</strong> <Badge>{induction.farmId ? farm.name : "All farms"}</Badge> <span className={ui.muted}>version {induction.version}</span>
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              For {induction.data.audiences.map((audience) => AUDIENCE_LABELS[audience].toLowerCase()).join(", ")}
              {induction.signVersion > 1 ? ` · people who signed before version ${induction.signVersion} sign again` : ""}
            </div>
            {manage ? null : (() => {
              const signed = mine(induction.recordId);
              return (
                <div style={{ fontSize: "var(--text-sm)" }}>
                  {!signed ? <Badge tone="amber">Not signed yet</Badge> : signed.current ? <><Badge tone="green">Signed</Badge> version {signed.data.inductionVersion}, {formatDateTime(signed.enteredAt)}</> : <><Badge tone="amber">Sign again</Badge> {signed.reasons[0] ?? ""}</>}
                </div>
              );
            })()}
            <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              {manage ? (
                <>
                  <Button size="small" variant="secondary" onClick={() => setReading({ id: induction.recordId, forSomeone: true })}>
                    Record for someone
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => setEditing(induction)}>
                    Change
                  </Button>
                </>
              ) : (
                <Button onClick={() => setReading({ id: induction.recordId, forSomeone: false })}>Read and sign</Button>
              )}
            </div>
            {reading?.id === induction.recordId ? <ReadAndSign organisationId={organisationId} farm={farm} inductionId={induction.recordId} forSomeone={reading.forSomeone} onDone={() => { setReading(null); onChanged(); }} onCancel={() => setReading(null)} /> : null}
          </li>
        ))}
      </ul>
      {manage ? (
        <>
        {data.canRecord && data.signoffs.some((signoff) => signoff.data.signedHow === "link" && signoff.data.audience === "contractor") ? (
          <p className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
            Contractors who signed through the sign-in link are {SELF_DECLARED.toLowerCase()}: their name is as they typed it. {INVITE_CONTRACTORS}
          </p>
        ) : null}
        <h3 style={{ fontSize: "var(--text-md, 16px)", margin: "14px 0 4px" }}>Who has signed {needAgain.length ? <Badge tone="amber">{`${needAgain.length} to sign again`}</Badge> : null}</h3>
        {!data.signoffs.length ? <p className={ui.muted}>Nobody yet.</p> : null}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {data.signoffs.map((signoff) => {
            const induction = data.inductions.find((each) => each.recordId === signoff.data.inductionId);
            return (
              <li key={signoff.recordId} style={{ padding: "4px 0" }}>
                <strong>{whoText(signoff.data.person)}</strong> {signoff.current ? <Badge tone="green">Up to date</Badge> : <Badge tone="amber">Sign again</Badge>}
                {signoff.data.signedHow === "link" ? <> <Badge>{SELF_DECLARED}</Badge></> : null}
                <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
                  {induction?.data.title ?? "Induction"} version {signoff.data.inductionVersion}, {formatDateTime(signoff.enteredAt)}, {SIGNED_HOW_LABELS[signoff.data.signedHow]}
                  {signoff.data.signedHow === "recorded" ? ` by ${signoff.enteredByName || signoff.enteredByEmail}` : ""}
                </div>
                {signoff.reasons.map((reason) => (
                  <div key={reason} style={{ fontSize: "var(--text-sm)" }}>
                    {reason}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
        </>
      ) : null}
      <p className={ui.muted}>{NOT_COMPETENCE}</p>
    </Card>
  );
}

function InductionForm({ organisationId, farm, current, onDone, onCancel }: { organisationId: string; farm: Farm; current: InductionView | null; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    title: current?.data.title ?? "Farm induction",
    shared: current ? current.farmId === null : true,
    audiences: current?.data.audiences ?? (["worker", "contractor", "visitor"] as Audience[]),
    sections: current?.data.sections ?? [
      { heading: "Before you start", text: "Sign in when you arrive and out when you leave. Tell us where you'll be working." },
      { heading: "Rules", text: "Helmets on bikes and quads. Keep to the tracks. Shut gates as you found them." },
    ],
    needsResign: false,
    why: "",
  });
  const [operationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const save = () =>
    void run(
      () =>
        current
          ? api(`/api/farming/safety/inductions/${current.recordId}`, { method: "POST", body: { organisationId, expectedVersion: current.version, operationId, title: form.title, audiences: form.audiences, sections: form.sections, needsResign: form.needsResign, why: form.why || undefined } })
          : api("/api/farming/safety/inductions", { method: "POST", body: { organisationId, operationId, farmId: form.shared ? null : farm.id, title: form.title, audiences: form.audiences, sections: form.sections } }),
      onDone,
    );
  return (
    <form onSubmit={(event) => { event.preventDefault(); save(); }} style={{ margin: "8px 0 12px", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name">
        <input value={form.title} required maxLength={150} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </Field>
      {!current ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.shared} onChange={(event) => setForm({ ...form, shared: event.target.checked })} /> Use on every farm (each farm&apos;s own hazards and emergency details still show with it)
        </label>
      ) : null}
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>For</legend>
        {AUDIENCES.map((audience) => (
          <label key={audience} className={ui.checkbox} style={{ marginRight: 12 }}>
            <input type="checkbox" checked={form.audiences.includes(audience)} onChange={(event) => setForm({ ...form, audiences: event.target.checked ? [...form.audiences, audience] : form.audiences.filter((each) => each !== audience) })} /> {AUDIENCE_LABELS[audience]}
          </label>
        ))}
      </fieldset>
      {form.sections.map((section, index) => (
        <div key={index} style={{ marginBottom: 8 }}>
          <Field label={`Section ${index + 1} heading`}>
            <input value={section.heading} maxLength={150} onChange={(event) => setForm({ ...form, sections: form.sections.map((each, at) => (at === index ? { ...each, heading: event.target.value } : each)) })} />
          </Field>
          <Field label="Text">
            <textarea value={section.text} rows={3} maxLength={5000} onChange={(event) => setForm({ ...form, sections: form.sections.map((each, at) => (at === index ? { ...each, text: event.target.value } : each)) })} />
          </Field>
          {form.sections.length > 1 ? (
            <Button size="small" variant="secondary" onClick={() => setForm({ ...form, sections: form.sections.filter((_, at) => at !== index) })}>
              Take out this section
            </Button>
          ) : null}
        </div>
      ))}
      <Button size="small" variant="secondary" onClick={() => setForm({ ...form, sections: [...form.sections, { heading: "", text: "" }] })}>
        Add a section
      </Button>
      {current ? (
        <>
          <label className={ui.checkbox} style={{ display: "flex", marginTop: 8 }}>
            <input type="checkbox" checked={form.needsResign} onChange={(event) => setForm({ ...form, needsResign: event.target.checked })} /> Everyone who signed before must read and sign again
          </label>
          <Field label="What changed">
            <input value={form.why} maxLength={1000} onChange={(event) => setForm({ ...form, why: event.target.value })} />
          </Field>
        </>
      ) : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {current ? "Save new version" : "Add induction"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The induction to read, the farm's hazards and emergency details, then the sign-off. */
export function ReadAndSign({ organisationId, farm, inductionId, forSomeone, onDone, onCancel }: { organisationId: string; farm: Farm; inductionId: string; forSomeone: boolean; onDone: () => void; onCancel: () => void }) {
  const toRead = useApiData<InductionToRead>(`/api/farming/safety/inductions/${inductionId}/read`, { organisationId, farmId: farm.id });
  const [ticked, setTicked] = useState(false);
  const [person, setPerson] = useState({ name: "", company: "", phone: "" });
  const [audience, setAudience] = useState<Audience | "">("");
  const [operationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  if (toRead.error) return <Notice tone="error">{toRead.error}</Notice>;
  if (!toRead.data) return <p className={ui.muted}>Loading…</p>;
  const { induction, hazards, emergency } = toRead.data;
  const chosen = audience || (forSomeone ? induction.data.audiences.find((each) => each !== "worker") : induction.data.audiences[0]) || induction.data.audiences[0];
  return (
    <div style={{ margin: "8px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>
        {induction.data.title} <span className={ui.muted}>(version {induction.version})</span>
      </h3>
      {induction.data.sections.map((section, index) => (
        <section key={index}>
          <h4 style={{ margin: "8px 0 2px" }}>{section.heading}</h4>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{section.text}</p>
        </section>
      ))}
      <h4 style={{ margin: "12px 0 2px" }}>Hazards on {farm.name}</h4>
      {!hazards.length ? <p className={ui.muted}>None recorded.</p> : null}
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {hazards.map((hazard) => (
          <li key={hazard.id}>
            <strong>{hazard.title}</strong> {hazard.noGo ? <Badge tone="red">No-go</Badge> : null} <Badge tone={hazard.level === "high" ? "red" : hazard.level === "medium" ? "amber" : "neutral"}>{HAZARD_LEVEL_LABELS[hazard.level]}</Badge>
            {hazard.controls ? <div>{hazard.controls}</div> : null}
          </li>
        ))}
      </ul>
      <h4 style={{ margin: "12px 0 2px" }}>In an emergency</h4>
      <p style={{ margin: 0 }}>
        Call 111. {emergency?.data.assemblyPoint ? `Assembly point: ${emergency.data.assemblyPoint}. ` : ""}
        {emergency?.data.address ? `Address: ${emergency.data.address}. ` : ""}
        {emergency?.data.noCoveragePlan ? `No coverage: ${emergency.data.noCoveragePlan}` : ""}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => api("/api/farming/safety/signoffs", { method: "POST", body: { organisationId, farmId: farm.id, inductionId, inductionVersion: induction.version, acknowledged: ticked, audience: chosen, operationId, ...(forSomeone ? { person } : {}) } }), onDone);
        }}
        style={{ marginTop: 12 }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {forSomeone ? (
          <>
            <p className={ui.muted}>For someone without a login. It shows as recorded by you, not signed by them.</p>
            <div className={ui.inlineForm}>
              <Field label="Their name">
                <input value={person.name} required maxLength={150} onChange={(event) => setPerson({ ...person, name: event.target.value })} />
              </Field>
              <Field label="Company">
                <input value={person.company} maxLength={150} onChange={(event) => setPerson({ ...person, company: event.target.value })} />
              </Field>
              <Field label="Phone">
                <input type="tel" value={person.phone} maxLength={40} onChange={(event) => setPerson({ ...person, phone: event.target.value })} />
              </Field>
            </div>
          </>
        ) : null}
        {induction.data.audiences.length > 1 ? (
          <Field label="Signing as">
            <select value={chosen} onChange={(event) => setAudience(event.target.value as Audience)}>
              {induction.data.audiences.map((each) => (
                <option key={each} value={each}>
                  {AUDIENCE_LABELS[each].replace(/s$/, "")}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <label className={ui.checkbox} style={{ display: "flex", alignItems: "flex-start" }}>
          <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} /> {forSomeone ? `They say: "${SIGN_STATEMENT}"` : SIGN_STATEMENT}
        </label>
        <p className={ui.muted}>{NOT_COMPETENCE}</p>
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !ticked || (forSomeone && !person.name.trim())}>
            {forSomeone ? "Record sign-off" : "Sign"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

// The farm's sign-in link -----------------------------------------------------------------------------

function SiteLinkCard({ organisationId, farm, links, onChanged }: { organisationId: string; farm: Farm; links: SiteLink[]; onChanged: () => void }) {
  const [expiresOn, setExpiresOn] = useState("");
  const [made, setMade] = useState<{ url: string; qrSvg: string } | null>(null);
  const { busy, error, run } = useRun();
  return (
    <Card
      title="Sign-in link for visitors and contractors"
      description={`A QR code for the gate or the shed. Without a Tohyee login, people see this farm's emergency details, hazards and visitor induction, then sign it and sign in. They never see who else is on site, or any report. Anyone with the link can see those details, so turn it off if it gets out. Sign-offs through the link are self-declared, with no login: fine for visitors. ${INVITE_CONTRACTORS}`}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {made ? (
        <div style={{ margin: "8px 0" }}>
          <Notice tone="success">Here&apos;s the link. It&apos;s only shown now: print the QR code or copy the address.</Notice>
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG made here, as a data address */}
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(made.qrSvg)}`} alt={`QR code for ${farm.name}'s sign-in link`} style={{ width: 200, height: 200, background: "#fff", padding: 8, borderRadius: 8 }} />
          <p style={{ overflowWrap: "anywhere" }}>
            <code>{made.url}</code>
          </p>
        </div>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Works until (optional)">
          <DateInput value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </Field>
        <Button disabled={busy} onClick={() => void run(() => api<{ url: string; qrSvg: string }>("/api/farming/safety/site-links", { method: "POST", body: { organisationId, farmId: farm.id, expiresOn: expiresOn || null } }), (result) => { setMade(result); onChanged(); })}>
          Make a sign-in link
        </Button>
      </div>
      {links.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
          {links.map((link) => (
            <li key={link.id} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
              {link.on ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>} <span className={ui.muted}>made {formatDateTime(link.createdAt)} by {link.createdByEmail}{link.expiresOn ? ` · until ${formatDate(link.expiresOn)}` : ""}{link.lastUsedAt ? ` · last used ${formatDateTime(link.lastUsedAt)}` : " · not used yet"}</span>{" "}
              {link.on ? (
                <Button size="small" variant="danger" disabled={busy} onClick={() => void run(() => api(`/api/farming/safety/site-links/${link.id}`, { method: "POST", body: { organisationId } }), onChanged)}>
                  Turn off
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
