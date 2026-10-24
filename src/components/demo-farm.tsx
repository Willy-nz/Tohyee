"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { buildTime } from "@/lib/demo/build-time";
import type { DemoFarm } from "@/lib/demo/service";
import styles from "./demo-farm.module.css";

type State = { enabled: boolean; demo: DemoFarm | null };

/** The demo farm page's card (#437): what it is, and Add, Open, Reset and Delete, with progress while it's made. */
export function DemoFarmCard() {
  const router = useRouter();
  const confirm = useConfirm();
  const { selectOrganisation } = useWorkspace();
  const state = useApiData<State>("/api/demo-farm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = state.data?.demo ?? null;
  const building = demo?.status === "building";
  const { reload } = state;

  // Follows the build every two seconds while it runs.
  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(reload, 2000);
    return () => window.clearInterval(timer);
  }, [building, reload]);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const add = () => run(() => api("/api/demo-farm", { method: "POST", body: { action: "add" } }));
  const reset = async () => {
    const ok = await confirm("Reset the demo farm? Everything you've changed in it goes, and it's made again from the start. This takes a minute or so.", {
      title: "Reset the demo farm",
      confirmLabel: "Reset",
      danger: true,
    });
    if (ok) await run(() => api("/api/demo-farm", { method: "POST", body: { action: "reset" } }));
  };
  const remove = async () => {
    const ok = await confirm("Delete the demo farm? It's removed for good. You can add it again later.", { title: "Delete the demo farm", confirmLabel: "Delete", danger: true });
    if (ok) await run(() => api("/api/demo-farm", { method: "DELETE" }));
  };
  const open = () => {
    if (!demo) return;
    selectOrganisation(demo.organisationId);
    router.push("/operations");
    router.refresh();
  };

  if (state.error) return <Notice tone="error">{state.error}</Notice>;
  if (!state.data) return <p className={styles.muted}>Loading…</p>;
  if (!state.data.enabled && !demo) return <Notice>The demo farm is turned off on this server.</Notice>;

  return (
    <div className={styles.stack}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={demo ? "Your demo farm" : "Try the demo farm"}
        description="It's your own copy: only you can see it, and you can change anything in it. Each person can have one."
      >
        {!demo ? (
          <div className={styles.actions}>
            <Button onClick={() => void add()} disabled={busy}>
              Add the demo farm
            </Button>
            <span className={styles.muted}>It takes a minute or so to make. You can leave this page while it&apos;s made.</span>
          </div>
        ) : building ? (
          <div className={styles.progress}>
            <label htmlFor="demo-farm-progress">{demo.step ?? "Starting"}…</label>
            <progress id="demo-farm-progress" max={100} value={demo.percent} aria-valuetext={`${demo.percent}% done`} />
            <span className={styles.muted} aria-live="polite">
              {demo.percent}% done
            </span>
          </div>
        ) : demo.status === "failed" ? (
          <div className={styles.stack}>
            <Notice tone="error">{demo.error ?? "Making the demo farm failed."}</Notice>
            <div className={styles.actions}>
              <Button onClick={() => void run(() => api("/api/demo-farm", { method: "POST", body: { action: "reset" } }))} disabled={busy}>
                Try again
              </Button>
              <Button variant="secondary" onClick={() => void remove()} disabled={busy}>
                Delete it
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.stack}>
            <p className={styles.ready}>
              {demo.displayName} is ready{buildTime(demo.buildSeconds) ? ` (made in ${buildTime(demo.buildSeconds)})` : ""}. It shows a DEMO badge at the top of every page.
            </p>
            <div className={styles.actions}>
              <Button onClick={open} disabled={busy}>
                Open the demo farm
              </Button>
              <Button variant="secondary" onClick={() => void reset()} disabled={busy}>
                Reset
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                Delete
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card title="What's in it">
        <ul className={styles.list}>
          <li>Books from 1 June at least a year ago up to today: milk income from the co-op, bills, bank statements imported and reconciled, two-monthly GST returns, fixed assets and depreciation, and a budget for this season.</li>
          <li>Payroll for two staff, paid fortnightly, with PAYE paid to Inland Revenue.</li>
          <li>Two farms with mapped paddocks, weekly farm walks, grazings, supplements, fertiliser plans and applications, soil tests and co-op shares.</li>
          <li>About 300 dairy cows with replacements: calving, culls, bulls and the year-end count.</li>
          <li>The farm calendar and notebook, and ready-made Analytics reports: Farm performance, Accounts, Farm and Business overview.</li>
        </ul>
      </Card>
      <Card title="It never touches anything real">
        <p className={styles.muted}>
          Every name and figure is made up. Tohyee doesn&apos;t send email from the demo farm, connect it to banks, Inland Revenue or mailboxes, or run scheduled jobs that send or import for it.
        </p>
      </Card>
    </div>
  );
}
