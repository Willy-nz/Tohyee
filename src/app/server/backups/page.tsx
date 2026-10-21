"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ageText } from "@/lib/backups/age";
import type { BackupKeyStatus } from "@/lib/backups/key";
import type { BackupOverview, TargetSummary } from "@/lib/backups/overview";
import type { RecoveryKitStatus } from "@/lib/backups/recovery-kit";
import type { BackupSettings } from "@/lib/backups/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type FileRow = { name: string; sizeBytes: number; problem: string | null; header: { createdAt: string; displayName: string | null; kind: string } | null };

type Details = {
  settings: BackupSettings;
  overview: BackupOverview;
  keyStatus: BackupKeyStatus;
  recoveryKit: RecoveryKitStatus;
  files: FileRow[];
};

type Message = { tone: "success" | "error" | "info"; text: string } | null;

function size(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function targetName(target: { organisationId: string | null; displayName: string | null }): string {
  return target.displayName ?? target.organisationId ?? "Server (users and settings)";
}

const STATE_BADGE: Record<TargetSummary["state"], { tone: "green" | "amber" | "red" | "neutral"; label: string }> = {
  ok: { tone: "green", label: "Backed up" },
  old: { tone: "amber", label: "Out of date" },
  failed: { tone: "red", label: "Failed" },
  never: { tone: "amber", label: "Never" },
  running: { tone: "neutral", label: "Running" },
};

/**
 * Backups (#389, decisions 730-733): what's known about the backups and on
 * what evidence, where they go, and keeping a copy elsewhere. Every line
 * comes from work the server did; there's no "safe" badge.
 */
export default function ServerBackupsPage() {
  const { user } = useWorkspace();
  const [details, setDetails] = useState<Details | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => setDetails(await api<Details>("/api/admin/backups")), []);

  useEffect(() => {
    if (!user.isServerAdmin) return;
    let cancelled = false;
    api<Details>("/api/admin/backups").then(
      (result) => {
        if (!cancelled) setDetails(result);
      },
      (caught) => {
        if (!cancelled) setMessage({ tone: "error", text: errorMessage(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user.isServerAdmin]);

  async function act(name: string, work: () => Promise<string>) {
    setBusy(name);
    setMessage({
      tone: "info",
      text:
        name === "backup"
          ? "Backing up… this can take a few minutes."
          : name === "check"
            ? "Checking the newest backup files… this can take a few minutes."
            : name === "test"
              ? "Restoring the newest backups into a scratch database to test them… this can take a few minutes."
              : "Working…",
    });
    try {
      const text = await work();
      await load();
      setMessage({ tone: text.startsWith("!") ? "error" : "success", text: text.replace(/^!/, "") });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  const backUp = () =>
    act("backup", async () => {
      const { runs } = await api<{ runs: { status: string; error: string | null }[] }>("/api/admin/backups", { method: "POST", body: {} });
      const failed = runs.filter((run) => run.status !== "ok");
      return failed.length === 0
        ? `Backed up ${runs.length} ${runs.length === 1 ? "database" : "databases"}, and checked each file.`
        : `!${failed.length} of ${runs.length} failed: ${failed[0].error ?? "no message"}`;
    });

  const check = () =>
    act("check", async () => {
      const { checks } = await api<{ checks: { status: string; error: string | null }[] }>("/api/admin/backups/check", { method: "POST", body: {} });
      const failed = checks.filter((one) => one.status !== "ok");
      if (checks.length === 0) return "There are no backups to check yet.";
      return failed.length === 0
        ? `Read back and checked the newest backup of ${checks.length} ${checks.length === 1 ? "database" : "databases"}: all whole and unchanged.`
        : `!${failed.length} of ${checks.length} failed: ${failed[0].error ?? "no message"}`;
    });

  const testRestore = () =>
    act("test", async () => {
      const { checks } = await api<{ checks: { status: string; error: string | null }[] }>("/api/admin/backups/test-restore", { method: "POST", body: {} });
      const failed = checks.filter((one) => one.status !== "ok");
      if (checks.length === 0) return "There are no backups to test yet.";
      return failed.length === 0
        ? `Restored the newest backup of ${checks.length} ${checks.length === 1 ? "database" : "databases"} into a scratch database, checked it and removed it: all good.`
        : `!${failed.length} of ${checks.length} test restores failed: ${failed[0].error ?? "no message"}`;
    });

  const resume = async (copy: { id: string; displayName: string }) => {
    if (!(await confirm(`Turn on ${copy.displayName}'s automatic jobs? Queued emails are sent, and bank, payment and mailbox feeds start importing. Only do this once the original isn't running them, or the same things are sent and imported twice.`))) return;
    await act("resume", async () => {
      await api("/api/admin/backups/restore/resume", { method: "POST", body: { organisationId: copy.id } });
      return `Automatic jobs are on for ${copy.displayName}.`;
    });
  };

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Backups" />
        <Notice tone="warning">Only server admins can see the backups.</Notice>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Backups"
        description="Every night Tohyee backs up each organisation, and its own database of people and settings, into encrypted files. It checks each file after making it, and checks the newest ones again every week."
        actions={
          <>
            <Button onClick={() => void backUp()} disabled={busy !== null}>
              {busy === "backup" ? "Backing up…" : "Back up now"}
            </Button>
            <Button variant="secondary" onClick={() => void check()} disabled={busy !== null}>
              {busy === "check" ? "Checking…" : "Check backups now"}
            </Button>
            <Button variant="secondary" onClick={() => void testRestore()} disabled={busy !== null}>
              {busy === "test" ? "Testing…" : "Test a restore"}
            </Button>
            <Link href="/server/backups/restore" className={`${ui.button} ${ui.secondary}`}>
              Restore on this computer
            </Link>
          </>
        }
      />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {details ? <Status details={details} /> : <p className={ui.muted}>Loading…</p>}
      {details && details.overview.pausedCopies.length > 0 ? (
        <Card title="Restored copies with paused jobs" description="Their automatic jobs (sending emails, feeds, mailbox checks, repeating invoices, analytics loads) are off until you turn them on, so they can't send or import the same things as the original.">
          <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
            {details.overview.pausedCopies.map((copy) => (
              <li key={copy.id}>
                <strong>{copy.displayName}</strong> ({copy.id}), paused {formatDateTime(copy.pausedAt)}. {copy.reason}{" "}
                <Button variant="secondary" size="small" onClick={() => void resume(copy)} disabled={busy !== null}>
                  Turn on automatic jobs
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {details ? <Destination details={details} onSaved={load} /> : null}
      {details ? <Databases overview={details.overview} /> : null}
      {details ? <Files files={details.files} /> : null}
      {details ? <RecoveryKit details={details} onChanged={load} /> : null}
      <IndependentCopy />
      {details?.overview.recoveryKit.legacyFiles ? <BackupKey keyStatus={details.keyStatus} legacy={details.overview.recoveryKit.legacyFiles} onChecked={load} /> : null}
    </Page>
  );
}

function Status({ details }: { details: Details }) {
  const { overview, keyStatus } = details;
  const now = new Date();
  const total = overview.targets.length;
  const done = overview.targets.filter((t) => t.lastGoodAt).length;
  return (
    <Card title="Status" description="What Tohyee has done and checked. It doesn't say the backups are safe: it says what's been proven and what hasn't.">
      <dl className={ui.recordFields}>
        <div className={ui.recordField}>
          <dt>Latest backup</dt>
          <dd>
            {overview.everythingBackedUpAt
              ? `All ${total} databases, the oldest of them ${ageText(overview.everythingBackedUpAt, now)} (${formatDateTime(overview.everythingBackedUpAt)})`
              : done === 0
                ? "Nothing has been backed up yet."
                : `${done} of ${total} databases backed up; newest ${ageText(overview.newestBackupAt, now)}`}
          </dd>
        </div>
        <div className={ui.recordField}>
          <dt>Files checked again</dt>
          <dd>
            {overview.integrity.failed > 0 ? (
              <Badge tone="red">{overview.integrity.failed} failed</Badge>
            ) : overview.integrity.allCheckedAt ? (
              `All newest files read back and checked ${ageText(overview.integrity.allCheckedAt, now)}`
            ) : (
              "Not all checked yet"
            )}
          </dd>
        </div>
        <div className={ui.recordField}>
          <dt>Off-site copy</dt>
          <dd>
            {overview.destination.synced || overview.destination.kind === "network" ? <Badge tone="amber">Not verified</Badge> : <Badge tone="red">None</Badge>}{" "}
            <span className={ui.muted}>{overview.offSite.note}</span>
          </dd>
        </div>
        <div className={ui.recordField}>
          <dt>Last test restore</dt>
          <dd>
            {overview.testRestore.failed > 0 ? (
              <Badge tone="red">{overview.testRestore.failed} failed</Badge>
            ) : overview.testRestore.allAt ? (
              `Every database's newest backup restored and checked ${ageText(overview.testRestore.allAt, now)}`
            ) : overview.testRestore.lastAt ? (
              `Some, ${ageText(overview.testRestore.lastAt, now)}; not all yet`
            ) : (
              "Never: press Test a restore"
            )}
          </dd>
        </div>
        <div className={ui.recordField}>
          <dt>Recovery kit</dt>
          <dd>
            {!keyStatus.keySet ? (
              <Badge tone="red">No TOHYEE_SECRET_KEY on this server</Badge>
            ) : !details.recoveryKit.version ? (
              "There's no recovery key yet: the first backup makes one."
            ) : details.recoveryKit.checkedAt ? (
              `Version ${details.recoveryKit.version}: a saved kit was checked ${formatDateTime(details.recoveryKit.checkedAt)} by ${details.recoveryKit.checkedByEmail ?? "someone"}. That proves it was right then, not that it's still there.`
            ) : (
              <>
                <Badge tone="red">Not checked</Badge> <span className={ui.muted}>Version {details.recoveryKit.version}: nobody has checked a saved kit.</span>
              </>
            )}
          </dd>
        </div>
      </dl>
      {overview.attention.length > 0 ? (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>Needs attention</h3>
          {overview.attention.map((item) => (
            <Notice key={item.text} tone={item.level === "error" ? "error" : "warning"}>
              {item.text}
            </Notice>
          ))}
        </div>
      ) : null}
      {overview.notProven.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: "var(--text-md)" }}>Not proven yet</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {overview.notProven.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Destination({ details, onSaved }: { details: Details; onSaved: () => Promise<void> }) {
  const { settings, overview } = details;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [time, setTime] = useState(settings.time);
  const [folder, setFolder] = useState(settings.folder === settings.defaultFolder ? "" : settings.folder);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/admin/backups", { method: "PUT", body: { enabled, time, folder } });
      await onSaved();
      setMessage({ tone: "success", text: "Saved. Tohyee checked it can write to that folder." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const storage = overview.storage;
  return (
    <Card title="Where and when" description={`The backups go to ${overview.destination.description}: ${settings.folder}.`}>
      <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }}>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <label className={ui.checkbox}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Back up every night
        </label>
        <div className={ui.grid2}>
          <Field label="At (24-hour)" hint={`In ${settings.timeZone} time.`}>
            <input value={time} onChange={(event) => setTime(event.target.value)} inputMode="numeric" pattern="[0-2][0-9]:[0-5][0-9]" />
          </Field>
          <Field
            label="Folder"
            hint={
              <>
                A full path on this computer. Blank means the default ({settings.defaultFolder}). On Windows, choose it in the Tohyee server app (Backups, Browse or Use
                OneDrive): that also lets Tohyee&apos;s service write there.
              </>
            }
          >
            <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={settings.defaultFolder} />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
      <dl className={ui.recordFields} style={{ marginTop: 16 }}>
        <div className={ui.recordField}>
          <dt>Kept</dt>
          <dd>The newest backup of each of the last 14 days, and the first of each of the last 12 months. Older ones are deleted only after a new backup has been made and checked.</dd>
        </div>
        <div className={ui.recordField}>
          <dt>Space used</dt>
          <dd>
            {storage.fileCount} {storage.fileCount === 1 ? "file" : "files"}, {size(storage.usedBytes) || "0 KB"}
            {storage.freeBytes !== null ? `; ${size(storage.freeBytes)} free on that disk` : ""}
            {storage.nextBackupBytes > 0 ? `; each night's backup is about ${size(storage.nextBackupBytes)}` : ""}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function Databases({ overview }: { overview: BackupOverview }) {
  const now = new Date();
  return (
    <Card title="Each database">
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Database</th>
              <th>State</th>
              <th>Last good backup</th>
              <th className={ui.num}>Size</th>
              <th>Last checked again</th>
            </tr>
          </thead>
          <tbody>
            {overview.targets.map((target) => (
              <tr key={target.organisationId ?? "_server"}>
                <td>{targetName(target)}</td>
                <td>
                  <Badge tone={STATE_BADGE[target.state].tone}>{STATE_BADGE[target.state].label}</Badge>
                  {target.latestError ? <div className={ui.muted} style={{ maxWidth: 360 }}>{target.latestError}</div> : null}
                </td>
                <td>{target.lastGoodAt ? `${formatDateTime(target.lastGoodAt)} (${ageText(target.lastGoodAt, now)})` : "Never"}</td>
                <td className={ui.num}>{size(target.lastGoodBytes)}</td>
                <td>
                  {target.lastCheck ? (
                    target.lastCheck.ok ? (
                      `OK, ${ageText(target.lastCheck.at, now)}`
                    ) : (
                      <>
                        <Badge tone="red">Failed</Badge> <span className={ui.muted}>{target.lastCheck.error}</span>
                      </>
                    )
                  ) : (
                    "Not yet"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Files({ files }: { files: FileRow[] }) {
  return (
    <Card title="Backup files" description="Restoring one makes a new organisation (a copy), so the current books are never overwritten: use Restore on this computer.">
      {files.length === 0 ? (
        <p className={ui.muted}>There are no backup files in the folder yet.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Made</th>
                <th>Database</th>
                <th className={ui.num}>Size</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {files.slice(0, 60).map((file) => (
                <tr key={file.name}>
                  <td>{file.header ? formatDateTime(file.header.createdAt) : <Badge tone="red">Can&apos;t be read</Badge>}</td>
                  <td>{file.header ? (file.header.kind === "server" ? "Server (users and settings)" : file.header.displayName) : file.problem}</td>
                  <td className={ui.num}>{size(file.sizeBytes)}</td>
                  <td style={{ overflowWrap: "anywhere" }}>{file.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {files.length > 60 ? <p className={ui.muted}>And {files.length - 60} older files.</p> : null}
        </div>
      )}
    </Card>
  );
}

function IndependentCopy() {
  return (
    <Card title="Keep a copy that sync can't reach">
      <div style={{ display: "grid", gap: 8 }}>
        <p style={{ margin: 0 }}>
          A synced folder copies mistakes too: deleting a backup, or ransomware scrambling the folder, reaches the cloud copy as well. OneDrive and Google Drive keep
          earlier versions and a recycle bin for a while, which may get files back, but that isn&apos;t a guarantee.
        </p>
        <p style={{ margin: 0 }}>
          Now and then (once a month, say), copy the whole backup folder to a USB drive and keep it unplugged, somewhere other than this computer. The files are
          encrypted, so the drive alone doesn&apos;t give anyone your books; they still need the recovery kit.
        </p>
      </div>
    </Card>
  );
}

function BackupKey({
  keyStatus,
  legacy,
  onChecked,
}: {
  keyStatus: BackupKeyStatus;
  legacy: NonNullable<BackupOverview["recoveryKit"]["legacyFiles"]>;
  onChecked: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function show(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ key: string }>("/api/admin/backups/key", { method: "POST", body: { password } });
      setShown(result.key);
      setPassword("");
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function checkCopy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/admin/backups/key/check", { method: "POST", body: { key: pasted } });
      setPasted("");
      setShown(null);
      await onChecked();
      setMessage({ tone: "success", text: "That's the right key. Your saved copy was right just now." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  if (!keyStatus.keySet) return null;
  return (
    <Card
      title="Older backups' key"
      description={`${legacy.files} ${legacy.files === 1 ? "backup" : "backups"} in the folder were made before recovery kits. On another computer they open only with this server's older backup key (its TOHYEE_SECRET_KEY), not the recovery kit. The newest was made ${formatDateTime(legacy.newestMadeAt)}, so they're kept until about ${legacy.keepKeyUntilAbout}. ${keyStatus.savedCopyCheckedAt ? `A saved copy was checked ${formatDateTime(keyStatus.savedCopyCheckedAt)}.` : "Nobody has checked a saved copy of it."}`}
    >
      <div style={{ display: "grid", gap: 12 }}>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {shown ? (
          <Field label="The backup key" hint="Anyone with this key and the backup files can read the books. Copy it into your password manager now; it isn't shown again until someone types their password.">
            <input readOnly value={shown} onFocus={(event) => event.target.select()} style={{ fontFamily: "var(--mono)" }} />
          </Field>
        ) : (
          <form onSubmit={(event) => void show(event)} className={ui.inlineForm}>
            <Field label="Your password, to see the key">
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy || !password}>
              Show the key
            </Button>
          </form>
        )}
        <form onSubmit={(event) => void checkCopy(event)} className={ui.inlineForm}>
          <Field label="Check your saved copy">
            <input type="password" autoComplete="off" value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste the key from where you saved it" />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy || !pasted}>
            Check it
          </Button>
        </form>
      </div>
    </Card>
  );
}

type KitResult = { form: "code"; version: number; id: string; code: string } | { form: "file"; version: number; id: string; fileName: string; content: string };

/**
 * The recovery kit (decisions 735 and 736): the recovery key as a code or a
 * passphrase-protected file; checking a saved one by giving it back; making
 * a new recovery key.
 */
function RecoveryKit({ details, onChanged }: { details: Details; onChanged: () => Promise<void> }) {
  const status = details.recoveryKit;
  const older = details.overview.recoveryKit.olderVersions;
  const [form, setForm] = useState<"code" | "file">("code");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseAgain, setPassphraseAgain] = useState("");
  const [randomName, setRandomName] = useState(false);
  const [result, setResult] = useState<KitResult | null>(null);
  const [checkForm, setCheckForm] = useState<"code" | "file">("code");
  const [code, setCode] = useState("");
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [filePassphrase, setFilePassphrase] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  if (!status.keySet) return null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const suggest = () =>
    run(async () => {
      const { suggestedPassphrase } = await api<{ suggestedPassphrase: string }>("/api/admin/backups/recovery-kit");
      setPassphrase(suggestedPassphrase);
      setPassphraseAgain(suggestedPassphrase);
      setMessage({ tone: "info", text: "Tohyee suggested a passphrase. Save it in your password manager (not next to the file) before you get the file." });
    });

  const get = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      if (form === "file" && passphrase !== passphraseAgain) throw new Error("The two passphrases aren't the same.");
      const { kit } = await api<{ kit: KitResult }>("/api/admin/backups/recovery-kit", { method: "POST", body: { password, form, passphrase: form === "file" ? passphrase : undefined, randomName } });
      setPassword("");
      setResult(kit);
      if (kit.form === "file") {
        const url = URL.createObjectURL(new Blob([kit.content], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = kit.fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setPassphrase("");
        setPassphraseAgain("");
      }
      await onChanged();
    });
  };

  const check = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      await api("/api/admin/backups/recovery-kit/check", {
        method: "POST",
        body: checkForm === "code" ? { code } : { file: fileText ?? "", passphrase: filePassphrase },
      });
      setCode("");
      setFilePassphrase("");
      setResult(null);
      await onChanged();
      setMessage({ tone: "success", text: "That's the right recovery kit. Your saved copy was right just now; keep it where it is." });
    });
  };

  const rotate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      const { recoveryKit } = await api<{ recoveryKit: RecoveryKitStatus }>("/api/admin/backups/recovery-kit/rotate", { method: "POST", body: { password: rotatePassword } });
      setRotatePassword("");
      setResult(null);
      await onChanged();
      setMessage({ tone: "success", text: `Made recovery key version ${recoveryKit.version}. Backups from now on use it: save its kit now. Keep the earlier kit until the backups made with it age out.` });
    });
  };

  return (
    <Card
      title="Recovery kit"
      description="The one thing you need, with the backup files, to get the books back on another computer. It holds this server's recovery key and nothing else: not its passwords or settings."
    >
      <div style={{ display: "grid", gap: 16 }} id="recovery-kit">
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <p style={{ margin: 0 }}>
          {status.version
            ? `Recovery key version ${status.version} (fingerprint ${status.id}), made ${formatDateTime(status.createdAt)}. `
            : "There's no recovery key yet; getting the kit makes one. "}
          {status.checkedAt ? `A saved kit was checked ${formatDateTime(status.checkedAt)} by ${status.checkedByEmail}.` : "Nobody has checked a saved kit for it yet."}
        </p>
        {older.length > 0 ? (
          <Notice tone="warning">
            {older.map((entry) => `${entry.files} ${entry.files === 1 ? "backup needs" : "backups need"} recovery key version ${entry.version} (fingerprint ${entry.id}): keep that kit until about ${entry.keepKitUntilAbout}.`).join(" ")}
          </Notice>
        ) : null}

        <form onSubmit={get} style={{ display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>Save the recovery kit</h3>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <legend className={ui.muted} style={{ marginBottom: 4 }}>As</legend>
            <label className={ui.checkbox}>
              <input type="radio" name="kit-form" checked={form === "code"} onChange={() => setForm("code")} /> A recovery code, to put in a password manager or print
            </label>
            <label className={ui.checkbox}>
              <input type="radio" name="kit-form" checked={form === "file"} onChange={() => setForm("file")} /> A recovery file, locked with a passphrase you keep somewhere else
            </label>
          </fieldset>
          {form === "file" ? (
            <>
              <div className={ui.grid2}>
                <Field label="Passphrase for the file" hint="At least 14 characters. If every copy of it is lost, the file can't be opened.">
                  <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
                </Field>
                <Field label="The passphrase again">
                  <input type="password" autoComplete="new-password" value={passphraseAgain} onChange={(event) => setPassphraseAgain(event.target.value)} />
                </Field>
              </div>
              {passphrase && passphrase === passphraseAgain ? (
                <p className={ui.muted} style={{ margin: 0 }}>
                  Passphrase: <code style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{passphrase}</code>
                </p>
              ) : null}
              <div>
                <Button variant="secondary" size="small" onClick={() => void suggest()} disabled={busy}>
                  Suggest a passphrase
                </Button>
              </div>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={randomName} onChange={(event) => setRandomName(event.target.checked)} /> Give the file a random name
              </label>
              {randomName ? (
                <p className={ui.muted} style={{ margin: 0 }}>
                  Only a convenience: anyone who can open the file can see what it is, and try it. Tohyee recognises the file by what&apos;s in it, so you don&apos;t need to remember the name.
                </p>
              ) : null}
            </>
          ) : null}
          <Field label="Your password" hint="Typed again, because the kit can open the backups.">
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <div>
            <Button type="submit" disabled={busy || !password}>
              {form === "code" ? "Show the recovery code" : "Download the recovery file"}
            </Button>
          </div>
        </form>

        {result?.form === "code" ? (
          <div style={{ display: "grid", gap: 8 }}>
            <Field label={`Recovery code, version ${result.version}`} hint="Anyone with this code and the backup files can read the books. Copy it into your password manager now, or print it, then check it below.">
              <input readOnly value={result.code} onFocus={(event) => event.target.select()} style={{ fontFamily: "var(--mono)" }} />
            </Field>
            <div>
              <Button variant="secondary" size="small" onClick={() => void navigator.clipboard?.writeText(result.code)}>
                Copy
              </Button>{" "}
              <Button variant="secondary" size="small" onClick={() => setResult(null)}>
                Hide it
              </Button>
            </div>
          </div>
        ) : null}
        {result?.form === "file" ? (
          <Notice tone="success">
            Downloaded {result.fileName} (recovery key version {result.version}). Keep it somewhere other than the backup folder, and the passphrase somewhere other than the file. Then check it below.
          </Notice>
        ) : null}

        <div style={{ display: "grid", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>Where to keep it</h3>
          <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
            <li>Best: a password manager, as a secure note (the code) or attachment (the file).</li>
            <li>Good as well: printed, and kept somewhere safe away from this computer.</li>
            <li>
              Not beside the backups: anyone who can read both can read the books. A recovery file is encrypted, so it can go in ordinary OneDrive, but its
              passphrase can&apos;t.
            </li>
            <li>
              OneDrive Personal Vault (personal Microsoft accounts; a free account holds only a few files) adds a second sign-in step, but it&apos;s part of the
              same Microsoft account as the backups, so it isn&apos;t independent of them.
            </li>
          </ul>
        </div>

        <form onSubmit={check} style={{ display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>Check a saved kit</h3>
          <p className={ui.muted} style={{ margin: 0 }}>
            Give Tohyee your saved copy and it checks it against the key it holds. That proves the copy is right now; it can&apos;t prove the copy will still be
            there later.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <legend className={ui.muted} style={{ marginBottom: 4 }}>Check</legend>
            <label className={ui.checkbox}>
              <input type="radio" name="check-form" checked={checkForm === "code"} onChange={() => setCheckForm("code")} /> A recovery code
            </label>
            <label className={ui.checkbox}>
              <input type="radio" name="check-form" checked={checkForm === "file"} onChange={() => setCheckForm("file")} /> A recovery file
            </label>
          </fieldset>
          {checkForm === "code" ? (
            <Field label="Recovery code">
              <input autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} placeholder="RK1-…" style={{ fontFamily: "var(--mono)" }} />
            </Field>
          ) : (
            <div className={ui.grid2}>
              <Field label="Recovery file" hint={fileName ? `Chosen: ${fileName}` : "Its name doesn't matter."}>
                <input
                  type="file"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    setFileName(chosen?.name ?? "");
                    setFileText(null);
                    if (chosen) void chosen.text().then(setFileText);
                  }}
                />
              </Field>
              <Field label="Its passphrase">
                <input type="password" autoComplete="off" value={filePassphrase} onChange={(event) => setFilePassphrase(event.target.value)} />
              </Field>
            </div>
          )}
          <div>
            <Button type="submit" variant="secondary" disabled={busy || (checkForm === "code" ? !code : !fileText || !filePassphrase)}>
              Check it
            </Button>
          </div>
        </form>

        <details className={ui.collapsible}>
          <summary>Make a new recovery key</summary>
          <form onSubmit={rotate} style={{ display: "grid", gap: 12, marginTop: 8 }}>
            <p style={{ margin: 0 }}>
              If a kit was lost or someone else may have seen it, make a new recovery key. Backups from now on use it, and you save its kit. This server keeps the
              earlier key, so its older backups still open here; on another computer they still need the earlier kit until they age out (up to 12 months). A new
              key can&apos;t take back copies of older backups that someone already has with their kit.
            </p>
            <Field label="Your password">
              <input type="password" autoComplete="current-password" value={rotatePassword} onChange={(event) => setRotatePassword(event.target.value)} />
            </Field>
            <div>
              <Button type="submit" variant="danger" disabled={busy || !rotatePassword}>
                Make a new recovery key
              </Button>
            </div>
          </form>
        </details>
      </div>
    </Card>
  );
}
