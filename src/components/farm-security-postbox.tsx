"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { PostboxStatus } from "@/lib/camera-postbox/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { type Camera, formatBytes } from "@/lib/security-cameras/shared";
import styles from "./farm-security.module.css";

/*
 * Farm › Security › Post box (decisions 1226-1233): setting up the camera
 * post box step by step, each with why, and afterwards how it's going and
 * what to type into the Reolink app. Owners and admins only; the server
 * checks that on every call.
 */

const NEW_CODE_COMMAND = "sudo docker exec tohyee-postbox node /app/postbox.cjs pairing-code";

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.copyRow}>
      <code className={styles.command}>{text}</code>
      <Button
        size="small"
        variant="secondary"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : `Copy ${label}`}
      </Button>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <li className={styles.step}>
      <span className={styles.stepNumber} aria-hidden>
        {number}
      </span>
      <div className={styles.stepBody}>
        <h3 className={styles.stepTitle}>
          <span className={styles.srOnly}>Step {number}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}

export function PostboxScreen({ organisationId, onChanged }: { organisationId: string; onChanged: () => void }) {
  const loaded = useApiData<{ status: PostboxStatus }>("/api/farming/security/postbox", { organisationId });
  const cameras = useApiData<{ cameras: Camera[] }>("/api/farming/security/cameras", { organisationId, farmId: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const confirm = useConfirm();
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const status = loaded.data?.status;
  if (!status) return <p className={ui.muted}>Loading…</p>;

  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      setMessage(await work());
      loaded.reload();
      cameras.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const pair = () =>
    run(async () => {
      await api("/api/farming/security/postbox", { method: "POST", body: { organisationId, code } });
      setCode("");
      return "Connected. Tohyee sent the post box your cameras' logins.";
    });
  const check = () =>
    run(async () => {
      const answer = await api<{ result: { collected: number } | null }>("/api/farming/security/postbox/check", { method: "POST", body: { organisationId } });
      const collected = answer.result?.collected ?? 0;
      return collected ? `Checked. ${collected} new file${collected === 1 ? "" : "s"} collected.` : "Checked.";
    });
  const unpair = async () => {
    if (!(await confirm("Disconnect the post box? Tohyee stops collecting from it, and the post box forgets your cameras' logins, so cameras can't upload to it. Files already waiting there stay until you pair again or they're 30 days old.", { title: "Disconnect the post box?", confirmLabel: "Disconnect" }))) return;
    await run(async () => {
      const answer = await api<{ toldPostbox: boolean }>(`/api/farming/security/postbox?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      return answer.toldPostbox ? "Disconnected." : "Disconnected in Tohyee. The post box couldn't be reached to tell it, so it may keep taking uploads until you pair it again or remove it.";
    });
  };

  const activeCameras = (cameras.data?.cameras ?? []).filter((camera) => camera.isActive);

  return (
    <div className={styles.stack}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {status.paired ? (
        <>
          <PostboxHealth status={status} busy={busy} onCheck={() => void check()} onUnpair={() => void unpair()} />
          <ReolinkSettings status={status} cameras={activeCameras} />
        </>
      ) : (
        <Card title="Camera post box" description="How 4G cameras get their photos and clips to Tohyee. Five steps, about 20 minutes.">
          <ol className={styles.steps}>
            <Step number={1} title="Why you need one">
              <p>A 4G camera is out on the internet. It can&apos;t reach Tohyee at home.</p>
              <p>
                A post box is a small rented server the cameras send to. Tohyee collects from it every minute.{" "}
                <InfoTip label="Why a post box">
                  <InfoPara>Remote access (the Tohyee address, Cloudflare or Tailscale) only carries web pages. Cameras send by FTP, which it can&apos;t carry.</InfoPara>
                  <InfoPara>Many New Zealand internet connections also share one public address between customers, so nothing outside can reach your home anyway.</InfoPara>
                  <InfoPara>The post box has its own public address. Tohyee reaches out to it, so nothing at home is opened to the internet.</InfoPara>
                  <InfoPara>Files are locked with a key only Tohyee has as soon as they arrive. Someone who took the post box couldn&apos;t open files waiting there. Tohyee deletes each one from the post box once it has it.</InfoPara>
                </InfoTip>
              </p>
              <p className={ui.muted}>
                Have a public address at home already?{" "}
                <InfoTip label="Without a post box">
                  <InfoPara>If your internet connection has its own fixed public address, cameras can send straight to Tohyee instead. The server&apos;s administrator turns on TOHYEE_CAMERA_FTP_PORT and forwards the ports on the router. See docs/FARM-SECURITY.md.</InfoPara>
                </InfoTip>
              </p>
            </Step>
            <Step number={2} title="Rent a small server">
              <ul className={styles.plainList}>
                <li>Ubuntu 24.04</li>
                <li>1 CPU, 1 GB memory, about 20 GB disk</li>
                <li>A public IPv4 address</li>
                <li>In Sydney or Auckland, if offered</li>
              </ul>
              <p>
                About $5 to $10 a month.{" "}
                <InfoTip label="Choosing a server">
                  <InfoPara>Any provider that rents Ubuntu servers (often called a VPS, droplet or instance) is fine. Examples: DigitalOcean, Vultr, Linode, or a New Zealand host. These are examples, not recommendations.</InfoPara>
                  <InfoPara>Sydney or Auckland is closer to the farm, so uploads are quicker. The disk holds files only until Tohyee collects them, so 20 GB is plenty.</InfoPara>
                  <InfoPara>It must have a public IPv4 address (not only IPv6): cameras need one to reach it.</InfoPara>
                </InfoTip>
              </p>
              <p>
                Open these ports in the provider&apos;s firewall: <strong>21</strong>, <strong>50000-50019</strong> and <strong>8443</strong> (TCP).{" "}
                <InfoTip label="Why these ports">
                  <InfoPara>21: cameras log in here. 50000-50019: cameras send each file on one of these. 8443: Tohyee collects from here.</InfoPara>
                  <InfoPara>Keep 22 (SSH) open too if you log in that way. Some providers have a firewall on their website as well as on the server; the install script opens the server&apos;s own.</InfoPara>
                </InfoTip>
              </p>
            </Step>
            <Step number={3} title="Paste the install command">
              <p>Log in to the server (the provider&apos;s web console, or SSH) and paste this:</p>
              <CopyText text={status.installCommand} label="command" />
              <p className={ui.muted}>
                It finishes by showing a pairing code.{" "}
                <InfoTip label="What the install does">
                  <InfoPara>It installs Docker and runs Tohyee&apos;s post box program in it. It opens the three ports on the server, makes the post box&apos;s own security certificate, and shows a pairing code.</InfoPara>
                  <InfoPara>It&apos;s from Tohyee&apos;s own releases, the same version as this Tohyee. Running it again is safe: files waiting are kept.</InfoPara>
                </InfoTip>
              </p>
            </Step>
            <Step number={4} title="Paste the pairing code">
              <Field label="Pairing code" hint="Starts with TPB1-. It works once, within a day.">
                <textarea value={code} rows={3} spellCheck={false} autoComplete="off" onChange={(event) => setCode(event.target.value)} className={styles.codeInput} />
              </Field>
              <p className={ui.muted}>
                Why a code?{" "}
                <InfoTip label="The pairing code">
                  <InfoPara>It proves the post box is yours. It also holds the post box&apos;s certificate fingerprint, so Tohyee knows it&apos;s really talking to your post box, every time.</InfoPara>
                  <InfoPara>Tohyee then makes a long secret key for itself and keeps it encrypted. The post box only keeps a fingerprint of it.</InfoPara>
                  <InfoPara>Lost it, or more than a day old? On the server, run: {NEW_CODE_COMMAND}</InfoPara>
                </InfoTip>
              </p>
              <div className={styles.row}>
                <Button disabled={busy || !code.trim()} onClick={() => void pair()}>
                  {busy ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </Step>
            <Step number={5} title="Tohyee tests it and shows the camera settings">
              <p>Once connected, Tohyee checks the post box and shows what to type into the Reolink app for each camera.</p>
            </Step>
          </ol>
        </Card>
      )}
    </div>
  );
}

function PostboxHealth({ status, busy, onCheck, onUnpair }: { status: PostboxStatus; busy: boolean; onCheck: () => void; onUnpair: () => void }) {
  const loud = status.error?.kind === "certificate_changed" || status.error?.kind === "token_refused";
  return (
    <Card
      title="Camera post box"
      description={`At ${status.address}. Tohyee collects from it every minute.`}
      actions={status.connected ? <Badge tone="green">Connected</Badge> : <Badge tone={loud ? "red" : "amber"}>Not connected</Badge>}
    >
      {status.error ? (
        <Notice tone={loud ? "error" : "warning"}>
          {status.error.kind === "certificate_changed" ? <strong>Stopped: the post box&apos;s certificate changed. </strong> : null}
          {status.error.text} <span className={ui.muted}>({formatDateTime(status.error.at)})</span>
        </Notice>
      ) : null}
      {status.lowDisk ? <Notice tone="warning">The post box&apos;s disk is nearly full, so it&apos;s refusing new uploads.</Notice> : null}
      <dl className={styles.facts}>
        <dt>Last heard from</dt>
        <dd>{status.lastContactAt ? formatDateTime(status.lastContactAt) : "Not yet"}</dd>
        <dt>Last collected</dt>
        <dd>{status.lastCollectedAt ? formatDateTime(status.lastCollectedAt) : "Nothing yet"}</dd>
        <dt>Files waiting</dt>
        <dd>{status.filesWaiting === null ? "Not known yet" : `${status.filesWaiting}${status.bytesWaiting ? ` (${formatBytes(status.bytesWaiting)})` : ""}`}</dd>
        <dt>Disk space free</dt>
        <dd>{status.diskFreeBytes === null || !status.diskTotalBytes ? "Not known yet" : `${formatBytes(status.diskFreeBytes)} of ${formatBytes(status.diskTotalBytes)}`}</dd>
        <dt>Collected so far</dt>
        <dd>{status.collectedTotal}</dd>
        <dt>Camera logins</dt>
        <dd>{status.loginsInSync ? "Up to date on the post box" : "Being sent to the post box"}</dd>
      </dl>
      <p className={ui.muted}>
        Paired {formatDateTime(status.pairedAt)}
        {status.pairedByEmail ? ` by ${status.pairedByEmail}` : ""}.{" "}
        <InfoTip label="How Tohyee knows it's your post box">
          {status.tlsMode === "pinned" ? (
            <InfoPara>Tohyee only talks to the post box with this certificate fingerprint: {status.fingerprint}. If it ever changes, Tohyee stops and says so here.</InfoPara>
          ) : (
            <InfoPara>The post box has a proper certificate for {status.address}, checked like a website&apos;s.</InfoPara>
          )}
          <InfoPara>Files on the post box are locked with a key only Tohyee has. File names and times aren&apos;t locked.</InfoPara>
          {status.boxVersion ? <InfoPara>Post box version {status.boxVersion}.</InfoPara> : null}
        </InfoTip>
      </p>
      <div className={styles.row}>
        <Button size="small" disabled={busy} onClick={onCheck}>
          {busy ? "Checking…" : "Check now"}
        </Button>
        <Button size="small" variant="secondary" disabled={busy} onClick={onUnpair}>
          Disconnect
        </Button>
      </div>
    </Card>
  );
}

function ReolinkSettings({ status, cameras }: { status: PostboxStatus; cameras: Camera[] }) {
  const ftp = status.ftp;
  if (!ftp) return null;
  return (
    <Card title="What to type into the Reolink app" description="For each camera: the camera › Settings › FTP.">
      <dl className={styles.login}>
        <dt>FTP server</dt>
        <dd>
          <code>{ftp.address}</code>
        </dd>
        <dt>Port</dt>
        <dd>
          <code>{ftp.port}</code>
        </dd>
        <dt>FTPS only</dt>
        <dd>On (encrypted)</dd>
        <dt>Transport mode</dt>
        <dd>Auto or Pasv</dd>
        <dt>Overwrite file</dt>
        <dd>No</dd>
      </dl>
      {!cameras.length ? <p className={ui.muted}>No cameras yet. Add them on the Cameras tab.</p> : null}
      <ul className={styles.cameraList} aria-label="Each camera's login">
        {cameras.map((camera) => (
          <li key={camera.id} className={styles.cameraItem}>
            <strong>
              {camera.name} <span className={ui.muted}>· {camera.farmName}</span>
            </strong>
            {camera.uploadUsername ? (
              <>
                <span>
                  User name <code>{camera.uploadUsername}</code>
                </span>
                <span className={ui.muted}>
                  Password: the one shown when the login was made.{" "}
                  <InfoTip label="The camera's password">
                    <InfoPara>Tohyee keeps only a scrambled copy, so it can&apos;t show it again. Lost it? Make a new upload login on the Cameras tab and type the new one into the app.</InfoPara>
                  </InfoTip>
                </span>
              </>
            ) : (
              <span className={ui.muted}>No upload login yet. Make one on the Cameras tab.</span>
            )}
          </li>
        ))}
      </ul>
      <p className={ui.muted}>
        Then use the app&apos;s FTP test.{" "}
        <InfoTip label="After setting up a camera">
          <InfoPara>A new or changed login reaches the post box within a minute. The test file should appear on the Events tab within another minute.</InfoPara>
          <InfoPara>None of this has been tried with a real Reolink camera yet, so check the first few uploads arrive.</InfoPara>
        </InfoTip>
      </p>
    </Card>
  );
}
