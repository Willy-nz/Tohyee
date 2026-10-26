"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { buildTime } from "@/lib/demo/build-time";
import type { DemoFarmListing } from "@/lib/demo/service";
import type { UserSummary } from "@/lib/users/admin";
import styles from "./demo-farm.module.css";

type State = { enabled: boolean; demoFarms: DemoFarmListing[] };

/**
 * The demo farm on the server's Organisations page (#445, decisions
 * 880-884): add it for yourself or another login, follow it being made, and
 * reset or delete it. Server admins only; each login can have one, and it
 * shows in that person's organisation list once it's made.
 */
export function DemoFarmsCard({ me, onChanged }: { me: { id: string; email: string }; onChanged: () => void }) {
  const confirm = useConfirm();
  const state = useApiData<State>("/api/admin/demo-farms");
  const users = useApiData<{ users: UserSummary[] }>("/api/admin/users");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const demoFarms = state.data?.demoFarms ?? [];
  const building = demoFarms.filter((demo) => demo.status === "building").length;
  const { reload } = state;

  // Follows the builds every two seconds while any runs, and refreshes the organisations list when one finishes.
  const wasBuilding = useRef(0);
  useEffect(() => {
    if (wasBuilding.current > building) onChanged();
    wasBuilding.current = building;
    if (!building) return;
    const timer = window.setInterval(reload, 2000);
    return () => window.clearInterval(timer);
  }, [building, reload, onChanged]);

  const taken = new Set(demoFarms.map((demo) => demo.userId));
  const others = (users.data?.users ?? []).filter((user) => user.isActive && user.id !== me.id && !taken.has(user.id));
  const mineTaken = taken.has(me.id);
  const chosen = owner || (mineTaken ? "" : me.email);

  async function run(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setStatus(null);
    try {
      await work();
      setStatus({ tone: "success", text: success });
      reload();
      onChanged();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    const self = chosen === me.email;
    await run(
      () => api("/api/admin/demo-farms", { method: "POST", body: { ownerEmail: self ? undefined : chosen } }),
      self ? "Making your demo farm. It shows in your organisation list when it's ready." : `Making the demo farm for ${chosen}. It shows in their organisation list when it's ready.`,
    );
    setOwner("");
  }

  async function reset(demo: DemoFarmListing) {
    const whose = demo.userId === me.id ? "your demo farm" : `${demo.email}'s demo farm`;
    const ok =
      demo.status === "failed" ||
      (await confirm(`Reset ${whose}? Everything changed in it goes, and it's made again from the start. This takes a minute or so.`, {
        title: "Reset the demo farm",
        confirmLabel: "Reset",
        danger: true,
      }));
    if (ok) await run(() => api(`/api/admin/demo-farms/${demo.userId}`, { method: "POST" }), `Making ${whose} again.`);
  }

  async function remove(demo: DemoFarmListing) {
    const whose = demo.userId === me.id ? "your demo farm" : `${demo.email}'s demo farm`;
    const ok = await confirm(`Delete ${whose}? Its database is removed for good. It can be added again later.`, { title: "Delete the demo farm", confirmLabel: "Delete", danger: true });
    if (ok) await run(() => api(`/api/admin/demo-farms/${demo.userId}`, { method: "DELETE" }), `Deleted ${whose}.`);
  }

  const enabled = state.data?.enabled ?? true;
  return (
    <Card
      title="Demo farm"
      description="Kōwhai Dairies Ltd: a made-up Otago dairy farm with about 18 months of books, payroll, GST, farm records and Analytics, to try Tohyee on. Each login can have one. It shows in that person's organisation list with a DEMO badge, and Tohyee never emails, imports or connects anything for it."
    >
      <div className={styles.stack}>
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {!enabled ? (
          <Notice>The demo farm is turned off on this server (TOHYEE_DEMO_FARM=off). Demo farms already made stay until they&apos;re deleted.</Notice>
        ) : (
          <form className={styles.add} onSubmit={(event) => void add(event)}>
            <Field label="Add it for">
              <select value={chosen} onChange={(event) => setOwner(event.target.value)} disabled={!state.data}>
                {mineTaken ? <option value="">Choose a login</option> : <option value={me.email}>Me ({me.email})</option>}
                {others.map((user) => (
                  <option key={user.id} value={user.email}>
                    {user.displayName && user.displayName !== user.email ? `${user.displayName} (${user.email})` : user.email}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" disabled={busy || !chosen || !state.data}>
              Add demo farm
            </Button>
            <p className={styles.note}>It&apos;s added to that login&apos;s organisation list once it&apos;s made (a minute or so). Only they can open it.</p>
          </form>
        )}
        {demoFarms.length ? (
          <ul className={styles.list} aria-label="Demo farms on this server">
            {demoFarms.map((demo) => (
              <li key={demo.organisationId} className={styles.item}>
                <div className={styles.who}>
                  <strong>
                    {demo.displayName} <Badge tone="amber">Demo</Badge>
                  </strong>
                  <span className={styles.muted}>
                    For {demo.userId === me.id ? `you (${demo.email})` : demo.email} · {demo.organisationId}
                  </span>
                </div>
                {demo.status === "building" ? (
                  <div className={styles.progress}>
                    <label htmlFor={`demo-progress-${demo.organisationId}`}>{demo.step ?? "Starting"}…</label>
                    <progress id={`demo-progress-${demo.organisationId}`} max={100} value={demo.percent} aria-valuetext={`${demo.percent}% done`} />
                    <span className={styles.muted} aria-live="polite">
                      {demo.percent}% done. You can leave this page while it&apos;s made.
                    </span>
                  </div>
                ) : demo.status === "failed" ? (
                  <Notice tone="error">{demo.error ?? "Making the demo farm failed."}</Notice>
                ) : (
                  <span className={styles.muted}>Ready{buildTime(demo.buildSeconds) ? `, made in ${buildTime(demo.buildSeconds)}` : ""}.</span>
                )}
                {demo.status !== "building" ? (
                  <div className={styles.actions}>
                    <Button size="small" variant="secondary" onClick={() => void reset(demo)} disabled={busy || !enabled}>
                      {demo.status === "failed" ? "Try again" : "Reset"}
                    </Button>
                    <Button size="small" variant="danger" onClick={() => void remove(demo)} disabled={busy}>
                      Delete
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : state.data ? (
          <p className={styles.muted}>No demo farms on this server.</p>
        ) : (
          <p className={styles.muted}>Loading…</p>
        )}
      </div>
    </Card>
  );
}
