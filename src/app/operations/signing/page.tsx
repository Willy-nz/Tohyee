"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OrganisationActions, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { SigningStateBadge, signingFileHref } from "@/components/signing/requests";
import { Button, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { LEGAL_NOTE, type RequestState, type SigningRequestView, SOURCE_LABELS } from "@/lib/signing/shared";

type Filter = { label: string; state: RequestState | null; empty: string };

const FILTERS: Filter[] = [
  { label: "Waiting", state: "sent", empty: "Nothing is waiting for signatures." },
  { label: "Signed", state: "completed", empty: "Nothing signed yet." },
  { label: "Declined", state: "declined", empty: "Nothing declined." },
  { label: "Expired", state: "expired", empty: "Nothing expired." },
  { label: "Voided", state: "voided", empty: "Nothing voided." },
  { label: "All", state: null, empty: "Nothing sent to sign yet." },
];

function List({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const data = useApiData<{ requests: SigningRequestView[]; email: { ready: boolean; reason: string | null } }>("/api/signing-requests", { organisationId, state: filter.state });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const { requests, email } = data.data;
  return (
    <>
      {!email.ready ? <Notice tone="warning">{email.reason}</Notice> : null}
      {!requests.length ? (
        <Empty>{filter.empty}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Document</th>
                <th>For</th>
                <th>Signers</th>
                <th>Sent</th>
                <th>Status</th>
                <th>Signed copy</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td data-label="Document">
                    <Link href={`/operations/signing/${request.id}`}>{request.title}</Link>
                  </td>
                  <td data-label="For">{SOURCE_LABELS[request.sourceKind]}</td>
                  <td data-label="Signers">
                    {request.signers.filter((signer) => signer.status === "signed").length} of {request.signers.length}: {request.signers.map((signer) => signer.name).join(", ")}
                  </td>
                  <td data-label="Sent">{formatDateTime(request.createdAt)}</td>
                  <td data-label="Status">
                    <SigningStateBadge state={request.state} />
                  </td>
                  <td data-label="Signed copy">{request.signedFileId ? <a href={signingFileHref(organisationId, request.id, "signed", true)}>Download</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Signing({ organisationId }: { organisationId: string }) {
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <div className={ui.listSection}>
      <div className={ui.tabs} role="tablist" aria-label="Signing status">
        {FILTERS.map((entry) => (
          <button key={entry.label} type="button" role="tab" aria-selected={filter === entry} className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`} onClick={() => setFilter(entry)}>
            {entry.label}
          </button>
        ))}
      </div>
      <List key={filter.label} organisationId={organisationId} filter={filter} />
      <p className={ui.muted}>
        About electronic signatures <InfoTip label="About electronic signatures">{LEGAL_NOTE}</InfoTip>
      </p>
    </div>
  );
}

/** Everything sent to sign that the person may see (decisions 1396-1410). */
export default function SigningPage() {
  const router = useRouter();
  return (
    <Page>
      <PageHeader title="Signing" actions={<OrganisationActions>{({ can }) => (can("bookkeeper") ? <Button onClick={() => router.push("/operations/signing/new")}>Send a document</Button> : null)}</OrganisationActions>} />
      <RequireOrganisation>{(organisationId) => <Signing organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
