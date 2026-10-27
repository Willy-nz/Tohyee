"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { type EmergencyData, FIXED_NUMBERS, HAZARD_LEVEL_LABELS, type HazardLevel, NOT_COMPETENCE, SIGN_STATEMENT } from "@/lib/safety/shared";

/*
 * The gate page (#446, decisions 948-952): no login. Shows the farm's
 * emergency details, hazards and visitor/contractor induction; signs the
 * person in and, from the same phone, out. Shows nothing about anyone
 * else. The details are kept on the phone so they can be read again with
 * no signal, with the time they were saved.
 */

type Site = {
  farmName: string;
  emergency: { data: EmergencyData; version: number; enteredAt: string } | null;
  hazards: Array<{ id: string; title: string; level: HazardLevel; noGo: boolean; controls: string | null; paddocks: string[] }>;
  inductions: Array<{ id: string; version: number; title: string; audiences: Array<"contractor" | "visitor">; sections: Array<{ heading: string; text: string }> }>;
};
type Cached = { savedAt: string; site: Site };
type Mine = { signOutToken: string; signedInAt: string; name: string };

const tel = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

function storageKey(kind: string, organisationId: string, token: string) {
  // The link's token isn't stored as is: a short hash of it names the entry.
  let hash = 0;
  for (const char of `${organisationId}/${token}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `tohyee.site.${kind}.${(hash >>> 0).toString(36)}`;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full phone: it still works while online.
  }
}

export function SiteSignIn({ organisationId, token }: { organisationId: string; token: string }) {
  const url = `/api/safety-site/${encodeURIComponent(organisationId)}/${encodeURIComponent(token)}`;
  const keys = useMemo(() => ({ site: storageKey("details", organisationId, token), mine: storageKey("me", organisationId, token) }), [organisationId, token]);
  const [state, setState] = useState<{ site: Site | null; cachedAt: string | null; error: string | null; loading: boolean }>({ site: null, cachedAt: null, error: null, loading: true });
  const [mine, setMine] = useState<Mine | null>(null);
  const [form, setForm] = useState({ name: "", company: "", phone: "", audience: "visitor" as "visitor" | "contractor", purpose: "", acknowledged: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as Site & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "This sign-in link isn't working.");
        return body;
      })
      .then(
        (site) => {
          if (cancelled) return;
          write(keys.site, { savedAt: new Date().toISOString(), site });
          setState({ site, cachedAt: null, error: null, loading: false });
          setMine(read<Mine>(keys.mine));
        },
        (error: unknown) => {
          if (cancelled) return;
          const cached = read<Cached>(keys.site);
          setState({ site: cached?.site ?? null, cachedAt: cached?.savedAt ?? null, error: error instanceof Error ? error.message : "No connection.", loading: false });
          setMine(read<Mine>(keys.mine));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [url, keys]);

  const site = state.site;
  const induction = site?.inductions.find((each) => each.audiences.includes(form.audience)) ?? site?.inductions[0] ?? null;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = (await response.json()) as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "That didn't work.");
    return result;
  };

  const signIn = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await post({ action: "sign_in", person: { name: form.name, company: form.company, phone: form.phone }, audience: form.audience, purpose: form.purpose, inductionId: induction?.id, inductionVersion: induction?.version, acknowledged: form.acknowledged });
      const signedIn = { signOutToken: String(result.signOutToken), signedInAt: String(result.signedInAt), name: form.name };
      write(keys.mine, signedIn);
      setMine(signedIn);
      setMessage({ tone: "success", text: `You're signed in, ${form.name}. Sign out here when you leave.` });
    } catch (error) {
      setMessage({ tone: "error", text: `Not signed in: ${error instanceof Error ? error.message : "no connection"}. Tell the farm you're here another way.` });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!mine) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await post({ action: "sign_out", signOutToken: mine.signOutToken });
      write(keys.mine, null);
      setMine(null);
      setMessage({ tone: "success", text: `Signed out at ${formatDateTime(String(result.signedOutAt))}. Thanks.` });
    } catch (error) {
      setMessage({ tone: "error", text: `Not signed out: ${error instanceof Error ? error.message : "no connection"}. Try again, or tell the farm you've left.` });
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <Page><p className={ui.muted}>Loading…</p></Page>;
  if (!site) return <Page><PageHeader title="Sign in on the farm" /><Notice tone="error">{state.error}</Notice></Page>;
  const emergency = site.emergency?.data;
  return (
    <div style={{ paddingTop: 16, minHeight: "100vh", background: "var(--background, transparent)" }}>
    <Page>
      <PageHeader title={site.farmName} description="Read this before you start, then sign in. Sign out when you leave." />
      {state.error ? <Notice tone="warning">Couldn&apos;t reach the farm&apos;s records ({state.error}). This is the copy saved on this phone {state.cachedAt ? formatDateTime(state.cachedAt) : ""}; it may be out of date. You can&apos;t sign in or out until there&apos;s a connection.</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card title="In an emergency">
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {FIXED_NUMBERS.map((number) => (
            <li key={number.phone}>
              <a href={tel(number.phone)} style={{ fontWeight: 700, fontSize: 18 }}>{number.phone}</a> {number.name}
            </li>
          ))}
          {(emergency?.contacts ?? []).map((contact, index) => (
            <li key={index}>
              <a href={tel(contact.phone)} style={{ fontWeight: 700 }}>{contact.phone}</a> {contact.name}{contact.role ? `, ${contact.role}` : ""}
            </li>
          ))}
        </ul>
        {emergency ? (
          <p style={{ marginBottom: 0 }}>
            {[emergency.address && `Address: ${emergency.address}`, emergency.entrance && `Entrance: ${emergency.entrance}`, emergency.assemblyPoint && `Assembly point: ${emergency.assemblyPoint}`, emergency.equipment.length ? `First aid and equipment: ${emergency.equipment.map((item) => `${item.what} (${item.where})`).join("; ")}` : null, emergency.noCoveragePlan && `No phone coverage: ${emergency.noCoveragePlan}`].filter(Boolean).join(". ")}
          </p>
        ) : null}
      </Card>
      <Card title={`Hazards (${site.hazards.length})`}>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {site.hazards.map((hazard) => (
            <li key={hazard.id} style={{ marginBottom: 6 }}>
              <strong>{hazard.title}</strong> {hazard.noGo ? <Badge tone="red">No-go</Badge> : null} <Badge tone={hazard.level === "high" ? "red" : hazard.level === "medium" ? "amber" : "neutral"}>{HAZARD_LEVEL_LABELS[hazard.level]}</Badge>
              {hazard.paddocks.length ? <span className={ui.muted}> · paddock {hazard.paddocks.join(", ")}</span> : null}
              {hazard.controls ? <div>{hazard.controls}</div> : null}
            </li>
          ))}
        </ul>
      </Card>
      {mine ? (
        <Card title="You're signed in">
          <p>
            {mine.name}, signed in {formatDateTime(mine.signedInAt)}.
          </p>
          <Button disabled={busy || Boolean(state.error)} onClick={() => void signOut()}>
            {busy ? "Signing out…" : "Sign out"}
          </Button>
        </Card>
      ) : (
        <Card title="Sign in">
          {induction ? (
            <>
              <h3 style={{ margin: "0 0 4px" }}>{induction.title}</h3>
              {induction.sections.map((section, index) => (
                <section key={index}>
                  <h4 style={{ margin: "8px 0 2px" }}>{section.heading}</h4>
                  <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{section.text}</p>
                </section>
              ))}
            </>
          ) : null}
          <form onSubmit={(event) => { event.preventDefault(); void signIn(); }} style={{ marginTop: 12 }}>
            <Field label="Your name">
              <input value={form.name} required maxLength={150} autoComplete="name" onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Company">
              <input value={form.company} maxLength={150} autoComplete="organization" onChange={(event) => setForm({ ...form, company: event.target.value })} />
            </Field>
            <Field label="Your phone">
              <input type="tel" value={form.phone} maxLength={40} autoComplete="tel" onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            </Field>
            <Field label="You're a">
              <select value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value as "visitor" | "contractor" })}>
                <option value="visitor">Visitor</option>
                <option value="contractor">Contractor</option>
              </select>
            </Field>
            <Field label="What you're here for">
              <input value={form.purpose} maxLength={300} onChange={(event) => setForm({ ...form, purpose: event.target.value })} />
            </Field>
            {induction ? (
              <label className={ui.checkbox} style={{ display: "flex", alignItems: "flex-start" }}>
                <input type="checkbox" checked={form.acknowledged} onChange={(event) => setForm({ ...form, acknowledged: event.target.checked })} /> {SIGN_STATEMENT}
              </label>
            ) : null}
            <p className={ui.muted}>{NOT_COMPETENCE} The farm keeps your name, company, phone and the times you sign in and out.</p>
            <Button type="submit" disabled={busy || Boolean(state.error) || !form.name.trim() || (Boolean(induction) && !form.acknowledged)}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
      )}
    </Page>
    </div>
  );
}
