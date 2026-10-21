"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ageText } from "@/lib/backups/age";
import type { BackupKeyStatus } from "@/lib/backups/key";
import type { BackupOverview, TargetSummary } from "@/lib/backups/overview";
import type { BackupSettings } from "@/lib/backups/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type FileRow = { name: string; sizeBytes: number; problem: string | null; header: { createdAt: string; displayName: string | null; kind: string } | null };

type Details = {
  settings: BackupSettings;
  overview: BackupOverview;
  keyStatus: BackupKeyStatus;
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
    setMessage({ tone: "info", text: name === "backup" ? "Backing up… this can take a few minutes." : name === "check" ? "Checking the newest backup files… this can take a few minutes." : "Working…" });
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
          </>
        }
      />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {details ? <Status details={details} /> : <p className={ui.muted}>Loading…</p>}
      {details ? <Destination details={details} onSaved={load} /> : null}
      {details ? <Databases overview={details.overview} /> : null}
      {details ? <Files files={details.files} /> : null}
      <IndependentCopy />
      {details ? <BackupKey keyStatus={details.keyStatus} onChecked={load} /> : null}
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
          <dt>Backup key</dt>
          <dd>
            {!keyStatus.keySet ? (
              <Badge tone="red">No key on this server</Badge>
            ) : keyStatus.savedCopyCheckedAt ? (
              `A saved copy was checked ${formatDateTime(keyStatus.savedCopyCheckedAt)} by ${keyStatus.savedCopyCheckedByEmail ?? "someone"}. That proves it was right then, not that it's still there.`
            ) : (
              <Badge tone="red">No saved copy checked</Badge>
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
    <Card title="Backup files" description="Restoring one makes a new organisation (a copy), so the current books are never overwritten. On Windows, restore from the Tohyee server app; elsewhere, with the command-line tool's backups restore.">
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
          encrypted, so the drive alone doesn&apos;t give anyone your books; they still need the backup key.
        </p>
      </div>
    </Card>
  );
}

function BackupKey({ keyStatus, onChecked }: { keyStatus: BackupKeyStatus; onChecked: () => Promise<void> }) {
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
      title="Backup key"
      description="Backups can only be opened with this server's backup key. If this computer is lost, you need a copy of it to restore them, so save one somewhere that isn't the backup folder, such as a password manager, then paste it back here to check it."
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
