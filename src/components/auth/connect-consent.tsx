"use client";

import { useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button, Field, Notice } from "@/components/ui";
import { AI_ACCESS_LEVEL_HELP, AI_ACCESS_LEVEL_LABELS, AI_ACCESS_LEVELS, type AiAccessLevel, FULL_ACCESS_CONNECTION_WARNING } from "@/lib/ai/access-levels";
import { APP_NAME_WARNING, LOOPBACK_WARNING } from "@/lib/ai/oauth/messages";
import type { ConsentDetails } from "@/lib/ai/oauth/authorize";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./auth.module.css";

const RANK: Record<AiAccessLevel, number> = { read: 0, draft: 1, post: 2, full: 3 };

/** The levels a person can give in an organisation: up to their role's ceiling (decision 346), Full access only for Owners (decision 488). */
export function consentLevels(ceiling: AiAccessLevel): AiAccessLevel[] {
  return AI_ACCESS_LEVELS.filter((level) => RANK[level] <= RANK[ceiling]);
}

/**
 * The consent screen for an AI app signing in (#427, decisions 818, 819).
 * The app's name and where it sends you back to are its own claims and are
 * shown as such; nothing is connected until the person presses Allow.
 */
export function ConnectConsent({ handle, details }: { handle: string; details: ConsentDetails }) {
  if (details.kind === "office") return <OfficeConsent handle={handle} details={details} />;
  return <AiAppConsent handle={handle} details={details} />;
}

/**
 * Tohyee's own PowerPoint add-in signing in (#429, decision 835). Nothing to
 * choose: it reads Analytics as you, in every organisation you can open
 * Analytics in, and can't change anything. It's Tohyee's own app on this
 * server (its details aren't the app's claims), so no name warning; the
 * address it sends you back to is still shown.
 */
function OfficeConsent({ handle, details }: { handle: string; details: ConsentDetails }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ redirectTo: string }>(`/api/oauth/requests/${handle}`, { method: "POST", body: { decision } });
      window.location.assign(result.redirectTo);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return (
    <div className={styles.screen}>
      <main className={`${styles.panel} ${styles.panelWide}`}>
        <div className={styles.brand}>
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        <div>
          <h1 className={styles.title}>Sign in to the PowerPoint add-in</h1>
          <p className={styles.text}>Tohyee&apos;s PowerPoint add-in wants to show your Analytics reports on slides, as you.</p>
        </div>
        <dl className={styles.facts}>
          <dt>App</dt>
          <dd>{details.appName} (this Tohyee&apos;s own add-in)</dd>
          <dt>After you choose, you&apos;ll go back to</dt>
          <dd>
            <span className={styles.host}>{details.redirectHost}</span>
          </dd>
          <dt>Signed in as</dt>
          <dd>{details.signedInAs}</dd>
          <dt>It can read Analytics in</dt>
          <dd>{details.organisations.length ? details.organisations.map((entry) => entry.displayName).join(", ") : "none of your organisations yet"}</dd>
        </dl>
        <p className={styles.text}>
          It only reads the Analytics reports you can see (a report viewer only the ones shared with them). It can&apos;t change anything in Tohyee, and can&apos;t see your books
          outside Analytics. You can sign it out at any time on the slide, or under Your account › Connected apps.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={styles.row}>
          <Button type="button" disabled={busy} onClick={() => void decide("allow")}>
            Allow
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void decide("deny")}>
            Don&apos;t allow
          </Button>
        </div>
      </main>
    </div>
  );
}

function AiAppConsent({ handle, details }: { handle: string; details: ConsentDetails }) {
  const [organisationId, setOrganisationId] = useState(details.organisations[0]?.id ?? "");
  const [accessLevel, setAccessLevel] = useState<AiAccessLevel>("read");
  const [fullConfirmed, setFullConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organisation = details.organisations.find((entry) => entry.id === organisationId) ?? null;
  const levels = organisation ? consentLevels(organisation.ceiling) : (["read"] as AiAccessLevel[]);

  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ redirectTo: string }>(`/api/oauth/requests/${handle}`, {
        method: "POST",
        body: { decision, organisationId, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: fullConfirmed } : {}) },
      });
      window.location.assign(result.redirectTo);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen}>
      <main className={`${styles.panel} ${styles.panelWide}`}>
        <div className={styles.brand}>
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        <div>
          <h1 className={styles.title}>Connect an AI app</h1>
          <p className={styles.text}>An app wants to use your Tohyee books as you. Check it&apos;s the one you&apos;re connecting.</p>
        </div>
        <dl className={styles.facts}>
          <dt>The app calls itself</dt>
          <dd>“{details.appName}”</dd>
          <dt>After you choose, you&apos;ll go back to</dt>
          <dd>
            <span className={styles.host}>{details.redirectHost}</span>
          </dd>
          <dt>Its details came from</dt>
          <dd>{details.detailsFrom.kind === "metadata_document" ? details.detailsFrom.host : "the app itself, when it registered with this Tohyee"}</dd>
          <dt>Signed in as</dt>
          <dd>{details.signedInAs}</dd>
        </dl>
        <Notice tone="warning">{APP_NAME_WARNING}</Notice>
        {details.loopbackOnly ? <Notice tone="warning">{LOOPBACK_WARNING}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {details.organisations.length === 0 ? (
          <>
            <Notice tone="info">You aren&apos;t a member of any organisation an AI app can use. Ask an admin to add you.</Notice>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void decide("deny")}>
              Go back to the app
            </Button>
          </>
        ) : (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void decide("allow");
            }}
          >
            <Field label="Organisation">
              <select
                value={organisationId}
                onChange={(event) => {
                  setOrganisationId(event.target.value);
                  setAccessLevel("read");
                  setFullConfirmed(false);
                }}
              >
                {details.organisations.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName} ({ROLE_LABELS[entry.role]})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What it may do" hint={AI_ACCESS_LEVEL_HELP[accessLevel]}>
              <select
                value={accessLevel}
                onChange={(event) => {
                  setAccessLevel(event.target.value as AiAccessLevel);
                  setFullConfirmed(false);
                }}
              >
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {AI_ACCESS_LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </Field>
            {accessLevel === "full" ? (
              <Notice tone="warning">
                <p>
                  <strong>Full access posts into your books.</strong> {FULL_ACCESS_CONNECTION_WARNING}
                </p>
                <label className={styles.check}>
                  <input type="checkbox" checked={fullConfirmed} onChange={(event) => setFullConfirmed(event.target.checked)} /> I understand. Give this app Full access.
                </label>
              </Notice>
            ) : null}
            <p className={styles.text}>
              It never deletes anything, and it can&apos;t reach payroll, users, roles, keys, lock dates or server settings.
              {organisation?.role === "owner" ? " It can't read your own mail unless you turn that on for it in My mail." : ""} You can disconnect it at any time
              on the AI page.
            </p>
            <div className={styles.row}>
              <Button type="submit" disabled={busy || !organisation || (accessLevel === "full" && !fullConfirmed)}>
                Allow
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void decide("deny")}>
                Don&apos;t allow
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
