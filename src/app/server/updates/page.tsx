"use client";

import { useState } from "react";
import { Badge, Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { LatestReleaseCheck } from "@/lib/updates/server-updates";

export default function ServerPage() {
  const { user } = useWorkspace();
  const [check, setCheck] = useState<LatestReleaseCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Updates" />
        <Notice tone="warning">Only server admins can check for updates.</Notice>
      </Page>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api<LatestReleaseCheck>("/api/updates/latest-release"));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Updates"
        description="Compares this server with the latest release on GitHub. Updating is still a manual step on the server."
      />
      <Card title="Check for a new version" actions={<Button onClick={() => void run()} disabled={busy}>{busy ? "Checking…" : "Check now"}</Button>}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {check ? (
          <div style={{ display: "grid", gap: 10 }}>
            <p>
              This server runs <strong>v{check.currentVersion}</strong>. The latest release is{" "}
              <strong>v{check.latestVersion}</strong>{" "}
              {check.updateAvailable ? <Badge tone="amber">Update available</Badge> : <Badge tone="green">Up to date</Badge>}
            </p>
            <p className={ui.muted}>
              {check.release.name ?? check.release.tagName}
              {check.release.publishedAt ? `, published ${formatDateTime(check.release.publishedAt)}` : ""} ·{" "}
              <a href={check.release.htmlUrl} target="_blank" rel="noreferrer">
                release notes
              </a>
              {check.release.preferredAsset ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={check.release.preferredAsset.downloadUrl} target="_blank" rel="noreferrer">
                    download {check.release.preferredAsset.name}
                  </a>
                </>
              ) : null}
            </p>
            <Notice tone="info">
              To update: back up every organisation database, stop the server, unpack the new bundle, and start it again.
              Database upgrades run automatically on start-up; an organisation whose upgrade fails is blocked (not half-upgraded)
              and shows under Organisations.
            </Notice>
          </div>
        ) : (
          <p className={ui.muted}>Press “Check now”.</p>
        )}
      </Card>
    </Page>
  );
}
