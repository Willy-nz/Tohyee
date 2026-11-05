"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatDateTime } from "@/lib/format";
import type { MemberActivity } from "@/lib/organisations/activity";

function Activity({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const params = useSearchParams();
  const userId = params.get("user") ?? "";
  const [before, setBefore] = useState<string | null>(null);
  const activity = useApiData<MemberActivity>(
    can("admin") && userId ? `/api/organisations/${organisationId}/members/${userId}/activity${before ? `?before=${encodeURIComponent(before)}` : ""}` : null,
  );
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can see what people did.</Notice>;
  if (!userId) return <Notice tone="warning">Choose someone on People and roles first.</Notice>;
  const data = activity.data;
  return (
    <>
      <p>
        <Link href="/operations/members">Back to People and roles</Link>
      </p>
      {activity.error ? <Notice tone="error">{activity.error}</Notice> : null}
      <Card
        title={data ? `What ${data.member.displayName} did` : "What they did"}
        description={
          <>
            Newest first, from the organisation&apos;s history.{" "}
            <InfoTip label="About this list">
              It shows what they did and when, not the details. Open a record to see its full history. Private mail is
              never shown, and payroll only if you have payroll access.
            </InfoTip>
          </>
        }
      >
        {data && data.entries.length === 0 ? <Empty>Nothing yet.</Empty> : null}
        {data && data.entries.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td data-label="When">{formatDateTime(entry.at)}</td>
                    <td data-label="What">{entry.what}</td>
                    <td data-label="How">{entry.via ?? (entry.where === "server" ? "Settings" : "In Tohyee")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {before ? (
            <Button variant="secondary" onClick={() => setBefore(null)}>
              Newest
            </Button>
          ) : null}
          {data?.before ? (
            <Button variant="secondary" onClick={() => setBefore(data.before)}>
              Older
            </Button>
          ) : null}
        </div>
      </Card>
    </>
  );
}

export default function MemberActivityPage() {
  return (
    <Page>
      <PageHeader title="What they did" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Activity key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
