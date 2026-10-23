"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BackupHeader } from "@/lib/backups/format";
import type { BackupInspection, FoundBackup, PeoplePlan } from "@/lib/backups/recovery";
import type { RestoreReport } from "@/lib/backups/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { cutoverChecklist, describeBackup } from "@/lib/backups/wizard";

type Material = "none" | "code" | "file" | "older";
type Message = { tone: "success" | "error" | "info" | "warning"; text: string } | null;

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * Restore on this computer (#389 part 3, decisions 737-739): find the
 * backups, give their recovery material, check one, then restore it as a new
 * organisation (or recover the people from a server backup). Nothing
 * existing is overwritten or deleted.
 */
export default function RestoreWizardPage() {
  const { user } = useWorkspace();
  const confirm = useConfirm();
  const [folder, setFolder] = useState("");
  const [found, setFound] = useState<{ folder: string; backups: FoundBackup[] } | null>(null);
  const [chosen, setChosen] = useState<FoundBackup | null>(null);
  const [material, setMaterial] = useState<Material>("none");
  const [code, setCode] = useState("");
  const [kitFile, setKitFile] = useState<string | null>(null);
  const [kitName, setKitName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [result, setResult] = useState<{ organisation: { id: string; displayName: string }; report: RestoreReport } | null>(null);
  const [plan, setPlan] = useState<PeoplePlan | null>(null);
  const [replace, setReplace] = useState<string[]>([]);
  const [resumed, setResumed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Restore on this computer" />
        <Notice tone="warning">Only server admins can restore backups.</Notice>
      </Page>
    );
  }

  const materialBody = () =>
    material === "code" || material === "older" ? { key: code } : material === "file" ? { kitFile: kitFile ?? "", passphrase } : {};
  const fileBody = () => ({ folder: found?.folder, file: chosen?.name, ...materialBody() });

  async function run(name: string, text: string, work: () => Promise<void>) {
    setBusy(name);
    setMessage({ tone: "info", text });
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  const find = () =>
    run("find", "Looking for backups…", async () => {
      const list = await api<{ folder: string; backups: FoundBackup[] }>("/api/admin/backups/restore/find", { method: "POST", body: { folder } });
      setFound(list);
      setChosen(null);
      setInspection(null);
      setResult(null);
      setPlan(null);
      setMessage(list.backups.length === 0 ? { tone: "warning", text: `There are no Tohyee backups in ${list.folder}. If it's a OneDrive folder, check OneDrive has downloaded the files to this computer.` } : null);
    });

  const choose = (backup: FoundBackup) => {
    setChosen(backup);
    setInspection(null);
    setResult(null);
    setPlan(null);
    setMessage(null);
    setMaterial(backup.header?.format === 1 ? "none" : "code");
  };

  const check = () =>
    run("check", "Checking the whole backup… this can take a few minutes.", async () => {
      const checked = await api<BackupInspection>("/api/admin/backups/restore/check", { method: "POST", body: fileBody() });
      setInspection(checked);
      setId(checked.suggestedId ?? "");
      setMessage({ tone: "success", text: "The backup opens with that recovery material, every byte of it is as it was made, and this server can take it." });
    });

  const restore = () =>
    run("restore", "Restoring… this can take a few minutes.", async () => {
      const done = await api<{ organisation: { id: string; displayName: string }; report: RestoreReport }>("/api/admin/backups/restore", {
        method: "POST",
        body: { ...fileBody(), id, displayName: displayName || undefined },
      });
      setResult(done);
      setResumed(false);
      setMessage({ tone: "success", text: `Restored as ${done.organisation.displayName} (${done.organisation.id}). Its automatic jobs are paused.` });
    });

  const people = (apply: boolean) =>
    run("people", apply ? "Recovering people…" : "Reading the people in the backup…", async () => {
      if (apply && replace.length > 0 && !(await confirm(`Replace the accounts here for ${replace.join(", ")} with the ones from the backup? Anyone using them is signed out and signs in again with their password (and two-step sign-in) from the old server.`))) return;
      const { plan: next } = await api<{ plan: PeoplePlan }>("/api/admin/backups/restore/people", { method: "POST", body: { ...fileBody(), apply, replace } });
      setPlan(next);
      setMessage(apply ? { tone: "success", text: `Recovered ${next.add.length} ${next.add.length === 1 ? "person" : "people"} and ${next.memberships.length} memberships.` } : null);
    });

  const resume = async () => {
    if (!result) return;
    const ok = await confirm(
      `Turn on ${result.organisation.displayName}'s automatic jobs? Queued emails (${result.report.queuedEmails}) are sent, and bank, payment and mailbox feeds start importing. Only do this once the original installation is switched off, or it'll send and import the same things.`,
    );
    if (!ok) return;
    await run("resume", "Turning on automatic jobs…", async () => {
      await api("/api/admin/backups/restore/resume", { method: "POST", body: { organisationId: result.organisation.id } });
      setResumed(true);
      setMessage({ tone: "success", text: "Automatic jobs are on for the restored copy." });
    });
  };

  const header: BackupHeader | null = chosen?.header ?? null;
  return (
    <Page>
      <PageHeader
        title="Restore on this computer"
        description="Bring an organisation, or the server's people, back from a backup. It always makes something new: nothing on this server is overwritten or deleted, and the copies never synchronise with the original."
        actions={<Link href="/server/backups">Back to Backups</Link>}
      />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card title="Replacing a lost computer?">
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
          <li>Find the backups below (the OneDrive folder once OneDrive has downloaded it, or a USB drive). Have the recovery kit ready.</li>
          <li>Choose the newest backup in the <strong>_server</strong> folder and recover the people: their logins, passwords and two-step sign-in.</li>
          <li>Restore each organisation, keeping its ID (the wizard suggests it).</li>
          <li>Recover the people again, to add their memberships of the organisations you restored.</li>
        </ol>
        <p className={ui.muted} style={{ margin: "8px 0 0" }}>
          Just one organisation? Restore it on its own: the people already on this server keep their access.
        </p>
      </Card>

      <Card title="1. Find the backups">
        <div className={ui.inlineForm}>
          <Field label="Folder on this computer" hint="Blank: this server's backup folder.">
            <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="C:\Users\you\OneDrive\Tohyee backups" />
          </Field>
          <Button onClick={() => void find()} disabled={busy !== null}>
            {busy === "find" ? "Looking…" : "Find backups"}
          </Button>
        </div>
        {found && found.backups.length > 0 ? (
          <div className={ui.tableWrap} style={{ marginTop: 12 }}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th aria-label="Choose" />
                  <th>Made</th>
                  <th>What</th>
                  <th>Tohyee</th>
                  <th>Key</th>
                  <th className={ui.num}>Size</th>
                </tr>
              </thead>
              <tbody>
                {found.backups.map((backup) => {
                  const described = describeBackup(backup);
                  return (
                    <tr key={backup.name}>
                      <td>
                        <input
                          type="radio"
                          name="backup"
                          aria-label={`Choose ${described.what}, ${backup.header ? formatDateTime(backup.header.createdAt) : backup.name}`}
                          checked={chosen?.name === backup.name}
                          disabled={!backup.header || !backup.compatible}
                          onChange={() => choose(backup)}
                        />
                      </td>
                      <td>{backup.header ? formatDateTime(backup.header.createdAt) : <Badge tone="red">Can&apos;t be read</Badge>}</td>
                      <td>
                        {described.what}
                        {described.note ? <div className={ui.muted}>{described.note}</div> : null}
                      </td>
                      <td>{backup.header?.tohyeeVersion ?? ""}</td>
                      <td>{described.key}</td>
                      <td className={ui.num}>{size(backup.sizeBytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {chosen && header ? (
        <Card title="2. Its recovery material" description={describeBackup(chosen).needs}>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <legend className={ui.muted} style={{ marginBottom: 4 }}>I have</legend>
            <label className={ui.checkbox}>
              <input type="radio" name="material" checked={material === "none"} onChange={() => setMaterial("none")} /> Nothing: this server made it
            </label>
            {header.format === 2 ? (
              <>
                <label className={ui.checkbox}>
                  <input type="radio" name="material" checked={material === "code"} onChange={() => setMaterial("code")} /> The recovery code
                </label>
                <label className={ui.checkbox}>
                  <input type="radio" name="material" checked={material === "file"} onChange={() => setMaterial("file")} /> The recovery file and its passphrase
                </label>
              </>
            ) : (
              <label className={ui.checkbox}>
                <input type="radio" name="material" checked={material === "older"} onChange={() => setMaterial("older")} /> The old server&apos;s backup key (its TOHYEE_SECRET_KEY)
              </label>
            )}
          </fieldset>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {material === "code" || material === "older" ? (
              <Field label={material === "code" ? "Recovery code" : "The old server's backup key"}>
                <input type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} style={{ fontFamily: "var(--mono)" }} />
              </Field>
            ) : null}
            {material === "file" ? (
              <div className={ui.grid2}>
                <Field label="Recovery file" hint={kitName ? `Chosen: ${kitName}` : "Its name doesn't matter: Tohyee reads what's in it."}>
                  <input
                    type="file"
                    onChange={(event) => {
                      const picked = event.target.files?.[0];
                      setKitName(picked?.name ?? "");
                      setKitFile(null);
                      if (picked) void picked.text().then(setKitFile);
                    }}
                  />
                </Field>
                <Field label="Its passphrase">
                  <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
                </Field>
              </div>
            ) : null}
            <div>
              <Button onClick={() => void check()} disabled={busy !== null || (material === "file" ? !kitFile || !passphrase : material !== "none" && !code)}>
                {busy === "check" ? "Checking…" : "3. Check this backup"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {inspection && header?.kind === "organisation" && !result ? (
        <Card title="4. Restore as a new organisation">
          <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
            <li>{header.displayName ?? header.organisationId}, as it was on {formatDateTime(header.createdAt)}, made by Tohyee {header.tohyeeVersion}.</li>
            <li>Opens with the recovery material, and every byte is as it was made (checked just now).</li>
            <li>This server can take its database version ({header.schemaVersion ?? "unknown"}); it&apos;s brought up to date as it&apos;s restored.</li>
            <li>
              {inspection.originalIdFree
                ? "This server has no organisation with its ID, so it keeps it (a replacement computer)."
                : "This server already has an organisation with its ID, so the copy gets a new one."}
            </li>
          </ul>
          <div className={ui.grid2}>
            <Field label="ID for the copy">
              <input value={id} onChange={(event) => setId(event.target.value)} />
            </Field>
            <Field label="Name (optional)" hint="Blank: its name, with the date of the backup.">
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </Field>
          </div>
          <Notice tone="info">
            The copy&apos;s automatic jobs (sending emails, bank and payment feeds, mailbox checks, repeating invoices, analytics loads) start paused, so it can&apos;t
            send or import the same things as the original. Stored secrets are re-encrypted for this server. Private mail stays its owner&apos;s: you become an
            Owner of the copy, but you can&apos;t read anyone else&apos;s private mail in it.
          </Notice>
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => void restore()} disabled={busy !== null || !id}>
              {busy === "restore" ? "Restoring…" : "Restore as a new organisation"}
            </Button>
          </div>
        </Card>
      ) : null}

      {result ? (
        <Card title="Restored: what was checked">
          <ul style={{ margin: "0 0 12px", paddingLeft: 20, display: "grid", gap: 4 }}>
            <li>
              {result.organisation.displayName} ({result.organisation.id}): {result.report.journals} journals and {result.report.attachments} attached files.
            </li>
            <li>
              Stored secrets: {result.report.secrets.reEncrypted} re-encrypted for this server, {result.report.secrets.current} already readable,{" "}
              {result.report.secrets.unreadable} unreadable.
              {result.report.reconnect.length > 0 ? ` Connect again: ${result.report.reconnect.join(", ")}.` : ""}
            </li>
            <li>
              Private mail: {result.report.privateMail.copies} {result.report.privateMail.copies === 1 ? "copy" : "copies"}, each still its owner&apos;s.
              {result.report.privateMail.ownersNotHere > 0
                ? ` ${result.report.privateMail.ownersNotHere} belong to people who aren't on this server yet: nobody can read them until those people are recovered.`
                : ""}
            </li>
            <li>
              Automatic jobs: {resumed ? "on." : `paused. ${result.report.queuedEmails} ${result.report.queuedEmails === 1 ? "email is" : "emails are"} waiting to be sent.`}
            </li>
          </ul>
          <h3 style={{ margin: "0 0 4px", fontSize: "var(--text-md)" }}>Before you switch to it</h3>
          <ol style={{ margin: "0 0 12px", paddingLeft: 20, display: "grid", gap: 4 }}>
            {cutoverChecklist(result.report).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          {!resumed ? (
            <div>
              <Button variant="secondary" onClick={() => void resume()} disabled={busy !== null}>
                Turn on automatic jobs
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {inspection && header?.kind === "server" ? (
        <Card title="4. Recover people from this server backup">
          <p style={{ marginTop: 0 }}>
            Adds each person who isn&apos;t on this server with the same login, password and two-step sign-in, and their memberships of organisations restored here
            with the same ID. Server settings (email sending, remote access, folders) aren&apos;t copied: set them up again here.
          </p>
          <Button variant="secondary" onClick={() => void people(false)} disabled={busy !== null}>
            See what it would do
          </Button>
          {plan ? (
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              <div>
                <strong>{plan.applied ? "Added" : "Would add"}:</strong>{" "}
                {plan.add.length ? plan.add.map((p) => `${p.email}${p.serverAdmin ? " (server admin)" : ""}${p.twoStep === "set up again" ? " (two-step sign-in needs setting up again)" : ""}`).join(", ") : "nobody"}
              </div>
              {plan.alreadyHere.length ? <div className={ui.muted}>Already here: {plan.alreadyHere.join(", ")}</div> : null}
              {plan.conflicts.length ? (
                <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend>
                    <strong>Here under another account</strong> (left alone unless ticked: the backup&apos;s account then takes its place and its memberships here)
                  </legend>
                  {plan.conflicts.map((conflict) => (
                    <label key={conflict.email} className={ui.checkbox}>
                      <input
                        type="checkbox"
                        checked={replace.includes(conflict.email)}
                        disabled={plan.applied}
                        onChange={(event) => setReplace(event.target.checked ? [...replace, conflict.email] : replace.filter((e) => e !== conflict.email))}
                      />{" "}
                      {conflict.email}
                      {conflict.email === user.email ? " (you: you'll be signed out and sign in again with your old password)" : ""}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div>
                <strong>Memberships {plan.applied ? "added" : "to add"}:</strong> {plan.memberships.length}
              </div>
              {plan.googleNotRestored.length ? (
                <div>
                  <strong>Sign in with Google {plan.applied ? "not restored" : "can't be restored"}</strong> (that Google account is linked to another login here):{" "}
                  {plan.googleNotRestored
                    .map((g) => `${g.email} (${g.googleEmail}, linked to ${g.linkedTo})${g.needsSetupLink ? ": they had only Google, so send them a setup link to choose a password" : ""}`)
                    .join("; ")}
                </div>
              ) : null}
              {plan.googleMoved.length ? (
                <div className={ui.muted}>
                  Keep the Google sign-in linked here, as the backup has none for them: {plan.googleMoved.join(", ")}
                </div>
              ) : null}
              {plan.organisationsNotHere.length ? (
                <div>
                  <strong>Not restored here yet</strong> (restore each from its own backup, keeping its ID, then recover people again):{" "}
                  {plan.organisationsNotHere.map((o) => `${o.displayName} (${o.id})`).join(", ")}
                </div>
              ) : null}
              {plan.settingsNotCopied.length ? <div className={ui.muted}>Settings not copied: {plan.settingsNotCopied.join(", ")}</div> : null}
              {!plan.applied ? (
                <div>
                  <Button onClick={() => void people(true)} disabled={busy !== null}>
                    Recover people
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}
    </Page>
  );
}
