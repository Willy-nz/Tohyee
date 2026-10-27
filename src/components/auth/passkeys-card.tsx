"use client";

import { type FormEvent, useState, useSyncExternalStore } from "react";
import { addPasskey, passkeysSupported } from "@/components/auth/passkey-client";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { PasskeyStatus, PasskeySummary } from "@/lib/auth/passkeys";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import styles from "./passkeys.module.css";

const noSubscribe = () => () => {};
type Status = { tone: "success" | "error"; text: string } | null;

/** One passkey: its name (renamed in place), where it works, when it was added and used, and Remove. */
function PasskeyRow({ passkey, onChanged, setStatus }: { passkey: PasskeySummary; onChanged: () => void; setStatus: (status: Status) => void }) {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [busy, setBusy] = useState(false);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/auth/passkeys/${passkey.id}`, { method: "PATCH", body: { name } });
      setRenaming(false);
      setStatus({ tone: "success", text: "Passkey renamed." });
      onChanged();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const text = passkey.thisSession
      ? `Remove "${passkey.name}"? You signed in with it: this session stays, but you'll need your password next time.`
      : `Remove "${passkey.name}"? It can't be used to sign in any more, and sessions signed in with it end.`;
    if (!(await confirm(text))) return;
    setBusy(true);
    try {
      await api(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE" });
      setStatus({ tone: "success", text: `"${passkey.name}" removed. You may also want to delete it from the device's passwords.` });
      onChanged();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
      setBusy(false);
    }
  }

  return (
    <li className={styles.item}>
      {renaming ? (
        <form className={styles.rename} onSubmit={(event) => void rename(event)}>
          <Field label="Name">
            <input value={name} maxLength={60} required autoFocus onChange={(event) => setName(event.target.value)} />
          </Field>
          <span className={ui.actions}>
            <Button type="submit" size="small" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => {
                setName(passkey.name);
                setRenaming(false);
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        <>
          <div className={styles.details}>
            <div className={styles.name}>
              {passkey.name} {passkey.thisSession ? <Badge tone="blue">This session</Badge> : null}
            </div>
            <div className={styles.meta}>
              Works {passkey.place} · added {formatDateTime(passkey.createdAt)} · {passkey.lastUsedAt ? `last used ${formatDateTime(passkey.lastUsedAt)}` : "not used yet"}
              {passkey.synced ? " · synced to your other devices" : ""}
            </div>
          </div>
          <span className={ui.actions}>
            <Button variant="secondary" size="small" aria-label={`Rename ${passkey.name}`} onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button variant="secondary" size="small" aria-label={`Remove ${passkey.name}`} disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </span>
        </>
      )}
    </li>
  );
}

/**
 * Passkeys on Your account (#450): sign in with Face ID, a fingerprint or
 * Windows Hello. Adding one needs your password again (or, without a
 * password, a fresh sign-in); the device does the face or finger check and
 * Tohyee keeps only the passkey's public key.
 */
export function PasskeysCard() {
  const loaded = useApiData<{ passkeys: PasskeyStatus }>("/api/auth/passkeys");
  const supported = useSyncExternalStore(noSubscribe, passkeysSupported, () => true);
  const [status, setStatus] = useState<Status>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = loaded.data?.passkeys;
  const list = data?.passkeys ?? [];
  const chosenName = name ?? data?.suggestedName ?? "";

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const outcome = await addPasskey({ password, name: chosenName });
    setBusy(false);
    if (outcome.ok) {
      setPassword("");
      setName(null);
      setStatus({ tone: "success", text: `Passkey added. Next time, choose Sign in with a passkey on the sign-in page.` });
      loaded.reload();
    } else if (outcome.message) {
      setStatus({ tone: "error", text: outcome.message });
    }
  }

  const canAdd = data && !data.problem && supported && list.length < data.max && (data.needsPassword || data.freshUntil);
  return (
    <Card title="Passkeys" description="Sign in with Face ID, a fingerprint or Windows Hello instead of your password and authenticator app. Your face or finger never leaves your device.">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {list.length ? (
        <ul className={styles.list} aria-label="Your passkeys">
          {list.map((passkey) => (
            <PasskeyRow key={`${passkey.id}-${passkey.name}`} passkey={passkey} onChanged={loaded.reload} setStatus={setStatus} />
          ))}
        </ul>
      ) : data ? (
        <p className={ui.muted}>You haven&apos;t added a passkey yet.</p>
      ) : null}
      {data?.problem ? <Notice tone="warning">{data.problem}</Notice> : null}
      {data && !data.problem && !supported ? <Notice tone="warning">This browser can&apos;t make passkeys. Try Safari, Chrome, Edge or Firefox on a recent phone or computer.</Notice> : null}
      {data && !data.problem && supported && !data.needsPassword && !data.freshUntil ? (
        <p className={ui.muted}>To add a passkey, sign out and sign in with Google again, then add it within 5 minutes. This checks it&apos;s really you.</p>
      ) : null}
      {canAdd ? (
        <form className={styles.add} onSubmit={(event) => void add(event)}>
          <Field label="Name" hint="So you can tell your passkeys apart, such as “Jess’s iPhone”.">
            <input value={chosenName} maxLength={60} required onChange={(event) => setName(event.target.value)} />
          </Field>
          {data.needsPassword ? (
            <Field label="Your password" hint="To check it's you before adding another way to sign in.">
              <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
          ) : null}
          <div>
            <Button type="submit" disabled={busy || (data.needsPassword && !password)}>
              {busy ? "Follow your device's prompt…" : "Add a passkey"}
            </Button>
          </div>
          <p className={ui.muted}>
            Your password still works. A passkey only works at the address it was added on ({data.rpId === "localhost" ? "localhost, on the server computer" : data.rpId}).
          </p>
        </form>
      ) : null}
    </Card>
  );
}
