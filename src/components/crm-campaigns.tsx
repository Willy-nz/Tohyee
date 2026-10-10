"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { Campaign, CampaignKind, CampaignMember, CampaignReport, CampaignStatus, MemberStatus } from "@/lib/crm/campaigns";
import { formatDate, formatMoney } from "@/lib/format";

const KIND_LABELS: Record<CampaignKind, string> = { email: "Email", event: "Event", advert: "Advert", social: "Social media", referral: "Referral", other: "Other" };
const STATUS_LABELS: Record<CampaignStatus, string> = { planned: "Planned", active: "Active", finished: "Finished" };
const MEMBER_LABELS: Record<MemberStatus, string> = { added: "Added", sent: "Sent", responded: "Responded" };

/** The campaigns, for choosing one (decision 498). */
export function useCampaigns(organisationId: string) {
  return useApiData<{ campaigns: Campaign[]; totals: Record<string, { leads: number; deals: number; won: number }> }>("/api/crm/campaigns", { organisationId });
}

/** A campaign picker; finished campaigns are left out unless already chosen. */
export function CampaignSelect({
  organisationId,
  value,
  onChange,
  label = "Campaign",
  blank = "None",
  disabled,
}: {
  organisationId: string;
  value: string;
  onChange: (id: string) => void;
  label?: string;
  blank?: string;
  disabled?: boolean;
}) {
  const campaigns = (useCampaigns(organisationId).data?.campaigns ?? []).filter((campaign) => campaign.status !== "finished" || campaign.id === value);
  return (
    <Field label={label}>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">{blank}</option>
        {campaigns.map((campaign) => (
          <option key={campaign.id} value={campaign.id}>
            {campaign.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

type CampaignForm = { name: string; kind: CampaignKind; status: CampaignStatus; startDate: string; endDate: string; budget: string; actualCost: string; description: string };

function CampaignEditor({ organisationId, campaign, onDone }: { organisationId: string; campaign: Campaign | null; onDone: () => void }) {
  const [form, setForm] = useState<CampaignForm>({
    name: campaign?.name ?? "",
    kind: campaign?.kind ?? "other",
    status: campaign?.status ?? "planned",
    startDate: campaign?.startDate ?? "",
    endDate: campaign?.endDate ?? "",
    budget: campaign?.budget ?? "",
    actualCost: campaign?.actualCost ?? "",
    description: campaign?.description ?? "",
  });
  const { busy, error, run } = useBusy();
  const field = (key: keyof CampaignForm, label: string, type = "text", hint?: string) => (
    <Field label={label} hint={hint}>
      <input type={type} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} {...(type === "text" ? { maxLength: 100 } : {})} />
    </Field>
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const body = {
        organisationId,
        ...form,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        budget: form.budget || null,
        actualCost: form.actualCost || null,
        description: form.description || null,
      };
      if (campaign) await api(`/api/crm/campaigns/${campaign.id}`, { method: "PATCH", body });
      else await api("/api/crm/campaigns", { method: "POST", body });
      onDone();
    });
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        {field("name", "Name")}
        <Field label="Kind">
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as CampaignKind })}>
            {(Object.keys(KIND_LABELS) as CampaignKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as CampaignStatus })}>
            {(Object.keys(STATUS_LABELS) as CampaignStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.inlineForm}>
        {field("startDate", "Starts", "date")}
        {field("endDate", "Ends", "date")}
        {field("budget", "Budget", "text", "In the base currency; for reports only.")}
        {field("actualCost", "Actual cost", "text", "Typed in; nothing goes into the books.")}
      </div>
      <Field label="Description (optional)">
        <textarea rows={2} maxLength={1000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <span className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          {campaign ? "Save campaign" : "Add campaign"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** CRM › Campaigns (decision 498). */
export function CampaignsPage({ organisationId }: { organisationId: string }) {
  const { canCrm } = useWorkspace();
  const data = useCampaigns(organisationId);
  const [adding, setAdding] = useState(false);
  const campaigns = data.data?.campaigns ?? [];
  return (
    <>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      <Card
        title="Campaigns"
        description="Events, adverts, emails and other ways leads find you. Each lead and deal has at most one source campaign, so what a deal earns is counted once."
        actions={canCrm("admin") && !adding ? <Button size="small" onClick={() => setAdding(true)}>Add campaign</Button> : null}
      >
        {adding ? (
          <CampaignEditor
            organisationId={organisationId}
            campaign={null}
            onDone={() => {
              setAdding(false);
              data.reload();
            }}
          />
        ) : null}
        {data.data && campaigns.length === 0 && !adding ? <Empty>No campaigns yet.</Empty> : null}
        {campaigns.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Dates</th>
                  <th className={ui.num}>Members</th>
                  <th className={ui.num}>Leads</th>
                  <th className={ui.num}>Deals (won)</th>
                  <th className={ui.num}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => {
                  const totals = data.data?.totals[campaign.id];
                  return (
                    <tr key={campaign.id}>
                      <td>
                        <Link href={`/crm/campaigns/${campaign.id}`}>{campaign.name}</Link>
                        <div className={ui.muted}>{KIND_LABELS[campaign.kind]}</div>
                      </td>
                      <td>{STATUS_LABELS[campaign.status]}</td>
                      <td>{[campaign.startDate, campaign.endDate].filter(Boolean).map((date) => formatDate(date)).join(" – ")}</td>
                      <td className={ui.num}>
                        {campaign.members} ({campaign.responded} responded)
                      </td>
                      <td className={ui.num}>{totals?.leads ?? 0}</td>
                      <td className={ui.num}>
                        {totals?.deals ?? 0} ({totals?.won ?? 0})
                      </td>
                      <td className={ui.num}>
                        {campaign.actualCost ? formatMoney(campaign.actualCost) : campaign.budget ? `${formatMoney(campaign.budget)} budget` : ""}
                        {campaign.overBudget ? <Badge tone="amber">Over budget</Badge> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

const amountsText = (amounts: CampaignReport["deals"]["wonAmounts"]) =>
  amounts.length === 0 ? "None" : amounts.map((entry) => `${entry.currencyCode} ${formatMoney(entry.amount)}`).join(" + ");

/** A campaign's report and members (decision 498). */
export function CampaignPage({ organisationId, campaignId }: { organisationId: string; campaignId: string }) {
  const { canCrm } = useWorkspace();
  const data = useApiData<{ report: CampaignReport; members: CampaignMember[] }>(`/api/crm/campaigns/${campaignId}`, { organisationId });
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useBusy();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const { report, members } = data.data;
  const { campaign } = report;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={campaign.name}
        description={`${KIND_LABELS[campaign.kind]} · ${STATUS_LABELS[campaign.status]}${campaign.startDate ? ` · ${formatDate(campaign.startDate)}` : ""}${campaign.endDate ? ` – ${formatDate(campaign.endDate)}` : ""}`}
        actions={canCrm("admin") && !editing ? <Button size="small" variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : null}
      >
        {editing ? (
          <CampaignEditor
            organisationId={organisationId}
            campaign={campaign}
            onDone={() => {
              setEditing(false);
              data.reload();
            }}
          />
        ) : (
          <>
            {campaign.description ? <p>{campaign.description}</p> : null}
            {report.scoped ? <Notice>These figures count only your own leads and deals.</Notice> : null}
            <div className={ui.grid3}>
              <Stat label="Members" value={`${members.length} · ${report.members.responded} responded · ${report.members.sent} sent`} />
              <Stat label="Leads from it" value={`${report.leads.sourced} · ${report.leads.converted} converted · ${report.leads.open} open`} />
              <Stat label="Deals from it" value={`${report.deals.sourced} · ${report.deals.won} won · ${report.deals.open} open`} />
              <Stat label="Won" value={amountsText(report.deals.wonAmounts)} />
              <Stat label="Open pipeline" value={amountsText(report.deals.openAmounts)} />
              <Stat
                label={`Cost (${report.baseCurrency})`}
                value={`${campaign.actualCost ? formatMoney(campaign.actualCost) : "Not entered"}${campaign.budget ? ` of ${formatMoney(campaign.budget)} budget` : ""}`}
              />
              <Stat label={`Cost per lead${report.costIsBudget ? " (budget)" : ""}`} value={report.costPerLead ? formatMoney(report.costPerLead) : "—"} />
              <Stat label={`Cost per won deal${report.costIsBudget ? " (budget)" : ""}`} value={report.costPerWonDeal ? formatMoney(report.costPerWonDeal) : "—"} />
            </div>
            <p className={ui.muted}>
              Amounts are in each deal&apos;s own currency and aren&apos;t added across currencies. The cost is typed in for reports and isn&apos;t in the books.
            </p>
          </>
        )}
      </Card>
      <Card title="Members" description="Add leads from the Leads list, or people and leads from their own pages. Sent and responded are set when they're emailed or reply, or by hand.">
        {members.length === 0 ? <Empty>Nobody yet.</Empty> : null}
        {members.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <Link href={member.leadId ? `/crm/leads/${member.leadId}` : `/crm/people/${member.personId}`}>{member.name}</Link>{" "}
                      <span className={ui.muted}>{member.leadId ? "Lead" : "Person"}</span>
                    </td>
                    <td>{member.company ?? ""}</td>
                    <td>{member.email ?? ""}</td>
                    <td>
                      <select
                        aria-label={`Status for ${member.name}`}
                        value={member.status}
                        disabled={busy || !canCrm("write")}
                        onChange={(event) =>
                          void run(async () => {
                            await api(`/api/crm/campaign-members/${member.id}`, { method: "PATCH", body: { organisationId, status: event.target.value } });
                            data.reload();
                          })
                        }
                      >
                        {(Object.keys(MEMBER_LABELS) as MemberStatus[]).map((status) => (
                          <option key={status} value={status}>
                            {MEMBER_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{formatDate(member.addedAt.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/** On a lead or person: the campaigns they're in, and adding them to one. On a lead or deal: its source campaign. */
export function CampaignPanel({
  organisationId,
  target,
  source,
  onChanged,
}: {
  organisationId: string;
  target: { leadId: string } | { personId: string } | { opportunityId: string };
  /** The record's source campaign, for a lead or deal. */
  source?: { id: string | null; editable: boolean };
  onChanged?: () => void;
}) {
  const { canCrm } = useWorkspace();
  const membership = "opportunityId" in target ? null : target;
  const members = useApiData<{ members: CampaignMember[] }>(membership ? "/api/crm/campaign-members" : null, { organisationId, ...(membership ?? {}) });
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useBusy();
  const writer = canCrm("write");
  const list = members.data?.members ?? [];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {source ? (
        <CampaignSelect
          organisationId={organisationId}
          label="Source campaign"
          value={source.id ?? ""}
          disabled={busy || !writer || !source.editable}
          onChange={(id) =>
            void run(async () => {
              await api("/api/crm/source-campaign", { method: "POST", body: { organisationId, ...target, campaignId: id || null } });
              members.reload();
              onChanged?.();
            })
          }
        />
      ) : null}
      {membership && list.length > 0 ? (
        <div className={ui.muted}>
          In:{" "}
          {list.map((member, index) => (
            <span key={member.id}>
              {index > 0 ? ", " : ""}
              <Link href={`/crm/campaigns/${member.campaignId}`}>{member.campaignName}</Link> ({MEMBER_LABELS[member.status].toLowerCase()})
            </span>
          ))}
        </div>
      ) : null}
      {membership && writer ? (
        <span className={ui.rowButtons}>
          <CampaignSelect organisationId={organisationId} label="Add to campaign" blank="Choose…" value={choice} onChange={setChoice} disabled={busy} />
          <Button
            size="small"
            variant="secondary"
            disabled={busy || !choice}
            onClick={() =>
              void run(async () => {
                await api(`/api/crm/campaigns/${choice}/members`, {
                  method: "POST",
                  body: { organisationId, ...("leadId" in membership ? { leadIds: [membership.leadId] } : { personIds: [membership.personId] }) },
                });
                setChoice("");
                members.reload();
              })
            }
          >
            Add
          </Button>
        </span>
      ) : null}
    </div>
  );
}
