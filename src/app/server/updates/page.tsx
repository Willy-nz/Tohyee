"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { ServerStart } from "@/lib/updates/server-starts";
import type { UpdateSummary } from "@/lib/updates/updates";

type Details = UpdateSummary & {
  lastUpdate: ServerStart | null;
  blockedOrganisations: { organisationId: string; displayName: string; error: string | null }[];
  platform: string;
};

export default function ServerUpdatesPage() {
  const { user } = useWorkspace();
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (check: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setDetails(check ? await api<Details>("/api/admin/updates/check", { method: "POST", body: {} }) : await api<Details>("/api/admin/updates"));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!user.isServerAdmin) return;
    let cancelled = false;
    api<Details>("/api/admin/updates").then(
      (result) => {
        if (!cancelled) setDetails(result);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user.isServerAdmin]);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Updates" />
        <Notice tone="warning">Only server admins can check for updates.</Notice>
      </Page>
    );
  }

  const windows = details?.platform === "win32";
  return (
    <Page>
      <PageHeader
        title="Updates"
        description="Tohyee checks GitHub for a new release a minute after it starts and then once a day."
      />
      <Card title="Latest release" actions={<Button onClick={() => void load(true)} disabled={busy}>{busy ? "Checking…" : "Check now"}</Button>}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {details ? (
          <div style={{ display: "grid", gap: 10 }}>
            {details.latestVersion ? (
              <p>
                This server runs <strong>v{details.currentVersion}</strong>. The latest release is <strong>v{details.latestVersion}</strong>{" "}
                {details.updateAvailable ? <Badge tone="amber">Update available</Badge> : <Badge tone="green">Up to date</Badge>}
              </p>
            ) : (
              <p>
                This server runs <strong>v{details.currentVersion}</strong>.{" "}
                {details.checkedAt ? "GitHub hasn't answered yet." : "It hasn't checked GitHub yet."}
              </p>
            )}
            {details.checkError ? <Notice tone="warning">The last check failed: {details.checkError}</Notice> : null}
            <p className={ui.muted}>
              {details.checkedAt ? `Last checked ${formatDateTime(details.checkedAt)}.` : ""}
              {details.nextCheckAt ? ` Next check ${formatDateTime(details.nextCheckAt)}.` : " Automatic checks are off."}
              {details.releaseNotesUrl ? (
                <>
                  {" "}
                  <a href={details.releaseNotesUrl} target="_blank" rel="noreferrer">
                    Release notes{details.releaseName ? ` (${details.releaseName})` : ""}
                  </a>
                  {details.publishedAt ? `, published ${formatDateTime(details.publishedAt)}` : ""}.
                </>
              ) : null}
            </p>
            {details.updateAvailable ? (
              windows ? (
                <Notice tone="info">
                  Install it from the Tohyee server app on this computer: click the Tohyee icon by the clock, then Updates, then Install. It backs up
                  every organisation, checks the download, installs it and reports how the database upgrades went.
                </Notice>
              ) : (
                <Notice tone="info">
                  To update: back up every organisation, stop the server, put the new version in place and start it again. Database upgrades run by
                  themselves when it starts; an organisation whose upgrade fails is blocked (not half-upgraded) and is listed below.
                </Notice>
              )
            ) : null}
          </div>
        ) : (
          <p className={ui.muted}>Loading…</p>
        )}
      </Card>
      {details?.lastUpdate ? (
        <Card title="Last update">
          <p>
            v{details.lastUpdate.previousVersion} → v{details.lastUpdate.version}, started {formatDateTime(details.lastUpdate.startedAt)}.{" "}
            {details.lastUpdate.organisationsBlocked.length === 0
              ? `All ${details.lastUpdate.organisationsChecked} organisations came up${details.lastUpdate.organisationsUpgraded > 0 ? ` (${details.lastUpdate.organisationsUpgraded} had database upgrades)` : ""}.`
              : `${details.lastUpdate.organisationsBlocked.length} of ${details.lastUpdate.organisationsChecked} organisations couldn't be upgraded.`}
          </p>
        </Card>
      ) : null}
      {details && details.blockedOrganisations.length > 0 ? (
        <Card title="Blocked organisations">
          <Notice tone="error">
            These organisations&apos; database upgrades failed, so nobody can use them until an upgrade works. Nothing was half-done: each upgrade
            step is all or nothing. The backup made before the update can be restored from Backups.
          </Notice>
          <ul>
            {details.blockedOrganisations.map((organisation) => (
              <li key={organisation.organisationId}>
                <strong>{organisation.displayName}</strong> ({organisation.organisationId}): {organisation.error ?? "no message"}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}
