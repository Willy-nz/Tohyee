"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { type CustomerMatch, SALES_PLATFORM_LABELS, type SalesPlatform } from "@/lib/sales-platforms/types";
import styles from "./store-setup.module.css";

/**
 * Customers to check (#539, decisions 1269-1272): a store's customers not
 * brought in because a contact has the same name and no email says who
 * they are. Everyone sees them; admins choose "Same person" (link to that
 * contact, after confirming) or "Different person" (a new contact under a
 * name that tells them apart). Shown only when there's something to check.
 */
export function CustomerMatches({
  organisationId,
  connectionId,
  platform,
  isAdmin,
  version,
  onResolved,
}: {
  organisationId: string;
  connectionId: string;
  platform: SalesPlatform;
  isAdmin: boolean;
  version: number;
  onResolved: (message: string) => void;
}) {
  const confirm = useConfirm();
  const shop = SALES_PLATFORM_LABELS[platform];
  const path = `/api/sales-platforms/connections/${connectionId}/customer-matches`;
  const data = useApiData<{ matches: CustomerMatch[]; total: number }>(path, { organisationId, v: version });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ externalId: string; name: string } | null>(null);

  if (!data.data || data.data.total === 0) return null;
  const { matches, total } = data.data;

  async function send(match: CustomerMatch, body: Record<string, unknown>) {
    setBusy(match.externalId);
    setError(null);
    try {
      const { result } = await api<{ result: { contactName: string; resolution: string } }>(path, {
        method: "POST",
        body: { organisationId, externalId: match.externalId, ...body },
      });
      setNaming(null);
      data.reload();
      onResolved(
        result.resolution === "same"
          ? `Linked ${shop} customer ${match.name} to contact ${result.contactName}. The contact's details weren't changed.`
          : `Added contact ${result.contactName} for ${shop} customer ${match.name}.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function same(match: CustomerMatch) {
    const ok = await confirm(
      `Link ${shop} customer ${describe(match.name, match.email)} to contact ${describe(match.contactName, match.contactEmail)}? Only do this if you've checked they're the same person: their ${shop} orders will go to this contact. The contact's details aren't changed${match.contactEmail ? ` (its email stays ${match.contactEmail})` : ""}.`,
      { title: "Same person?", confirmLabel: "Yes, same person" },
    );
    if (ok) await send(match, { resolution: "same", contactId: match.contactId });
  }

  return (
    <section aria-labelledby={`matches-${connectionId}`} style={{ display: "grid", gap: 8 }}>
      <h3 id={`matches-${connectionId}`} style={{ margin: 0, fontSize: "1rem" }}>
        Customers to check ({total.toLocaleString("en-NZ")}){" "}
        <InfoTip label="Why customers need checking">
          <InfoPara>
            These {shop} customers have the same name as a contact, and no matching email shows whether they&apos;re the same person. Two people can share a
            name, so Tohyee doesn&apos;t guess and doesn&apos;t change anyone&apos;s email.
          </InfoPara>
          <InfoPara>
            <strong>Same person</strong> links the customer to the contact; the contact&apos;s details stay as they are. <strong>Different person</strong> adds a
            new contact, with a name that tells them apart (contact names are unique). Either way the sync log records who decided, and later syncs treat the
            customer as linked. Orders waiting for the customer come in on the next sync.
          </InfoPara>
        </InfoTip>
      </h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className={styles.parts} aria-label="Customers to check">
        {matches.map((match) => {
          const blocked = match.contactArchived
            ? `Contact ${match.contactName} is archived.`
            : match.contactLinkedTo
              ? `Contact ${match.contactName} is already linked to ${shop} customer ${match.contactLinkedTo}.`
              : null;
          return (
            <li key={match.externalId} className={styles.match}>
              <span className={styles.partText}>
                <strong>{match.name}</strong> in {shop}: {match.email ?? "no email"}
                {match.phone ? `, ${match.phone}` : ""}
                <span className={styles.partReasons}>
                  Contact {match.contactName}: {match.contactEmail ?? "no email"}
                  {match.contactPhone ? `, ${match.contactPhone}` : ""}
                  {blocked ? ` · ${blocked}` : ""}
                </span>
              </span>
              {isAdmin && naming?.externalId !== match.externalId ? (
                <span className={ui.actions} style={{ justifyContent: "end" }}>
                  {blocked ? null : (
                    <Button size="small" variant="secondary" disabled={busy !== null} onClick={() => void same(match)} aria-label={`Same person: link ${match.name} to contact ${match.contactName}`}>
                      Same person
                    </Button>
                  )}
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => setNaming({ externalId: match.externalId, name: match.suggestedName })}
                    aria-label={`Different person: add a new contact for ${match.name}`}
                  >
                    Different person
                  </Button>
                </span>
              ) : null}
              {isAdmin && naming?.externalId === match.externalId ? (
                <form
                  className={styles.matchForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(match, { resolution: "different", name: naming.name });
                  }}
                >
                  <Field label="New contact's name" hint="Contact names are unique, so it needs to differ from the existing one.">
                    <input value={naming.name} maxLength={150} required onChange={(event) => setNaming({ ...naming, name: event.target.value })} />
                  </Field>
                  <span className={ui.actions}>
                    <Button type="submit" size="small" disabled={busy !== null || !naming.name.trim()}>
                      {busy === match.externalId ? "Adding…" : "Add contact"}
                    </Button>
                    <Button type="button" size="small" variant="secondary" onClick={() => setNaming(null)} disabled={busy !== null}>
                      Cancel
                    </Button>
                  </span>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      {total > matches.length ? <p className={ui.muted} style={{ margin: 0 }}>Showing the first {matches.length}; the rest appear as these are sorted out.</p> : null}
    </section>
  );
}

const describe = (name: string, email: string | null) => (email ? `${name} (${email})` : name);
