"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { GroupCustomers, LinkableContact } from "@/lib/consolidation/customers";
import type { StageMappingView } from "@/lib/consolidation/stage-mappings";
import type { ConsolidationGroup, ConsolidationMember } from "@/lib/consolidation/types";
import type { GroupWorkspace, TranslationBasis } from "@/lib/consolidation/workspace";
import type { CurrencyAmount } from "@/lib/consolidation/workspace-figures";
import { formatDate, formatDateTime, formatMoney, todayInBrowser } from "@/lib/format";

/**
 * The group workspace on screen (#200 stage 1, decisions 640-645): the
 * whole group on one page, its customers and stage mappings, and the
 * members' dates and steward in the group's settings.
 */

function stay(member: Pick<ConsolidationMember, "effectiveFrom" | "effectiveTo">): string {
  if (!member.effectiveFrom && !member.effectiveTo) return "Always";
  if (member.effectiveFrom && !member.effectiveTo) return `From ${formatDate(member.effectiveFrom)}`;
  if (!member.effectiveFrom) return `Until ${formatDate(member.effectiveTo)}`;
  return `${formatDate(member.effectiveFrom)} to ${formatDate(member.effectiveTo)}`;
}

/** Amounts per currency, one line each; never one total across currencies. */
function PerCurrency({ totals, weighted = false }: { totals: CurrencyAmount[] | null; weighted?: boolean }) {
  if (totals === null) return <span className={ui.muted}>CRM off</span>;
  if (totals.length === 0) return <span className={ui.muted}>None</span>;
  return (
    <>
      {totals.map((entry) => (
        <div key={entry.currencyCode}>
          {entry.currencyCode} {formatMoney(weighted ? entry.weighted : entry.amount)}
        </div>
      ))}
    </>
  );
}

export function GroupWorkspaceTab({ group }: { group: ConsolidationGroup }) {
  const [asAt, setAsAt] = useState(todayInBrowser());
  const [basis, setBasis] = useState<TranslationBasis>("none");
  const loaded = useApiData<{ workspace: GroupWorkspace & { fromCopy: boolean } }>(`/api/consolidation/groups/${group.id}/workspace`, { asAt, basis });
  const workspace = loaded.data?.workspace;
  return (
    <>
      <Card
        title="Group workspace"
        description="The whole group on one date: the consolidated books, the CRM pipeline and linked customers, read from each organisation's own records."
        actions={
          <div className={ui.inlineForm}>
            <Field label="As at">
              <DateInput value={asAt} onChange={(event) => setAsAt(event.target.value)} />
            </Field>
            <Field label="Pipeline currencies">
              <select value={basis} onChange={(event) => setBasis(event.target.value as TranslationBasis)}>
                <option value="none">Each currency on its own</option>
                <option value="consolidation_current">Also translated into {group.currencyCode}</option>
              </select>
            </Field>
          </div>
        }
      >
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {!workspace && !loaded.error ? <p className={ui.muted}>Loading…</p> : null}
        {workspace ? (
          <>
            <Notice tone="info">{workspace.taxNote}</Notice>
            {!workspace.complete ? (
              <Notice tone="warning">
                <strong>Not everything in the group is included.</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: "1.25rem" }}>
                  {workspace.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <div className={ui.statRow}>
              <Stat label={`Revenue, ${workspace.accounting.from ? formatDate(workspace.accounting.from) : "year"} to ${formatDate(workspace.accounting.to)}`} value={workspace.accounting.revenue === null ? "Not available" : `${group.currencyCode} ${formatMoney(workspace.accounting.revenue)}`} />
              <Stat label="Net profit, after eliminations" value={workspace.accounting.netProfit === null ? "Not available" : `${group.currencyCode} ${formatMoney(workspace.accounting.netProfit)}`} />
              <Stat label="Open pipeline now" value={<PerCurrency totals={workspace.pipeline.byCurrency} />} />
            </div>
            {workspace.pipeline.translated ? (
              <p>
                <strong>
                  Open pipeline in {workspace.pipeline.translated.currencyCode}: {formatMoney(workspace.pipeline.translated.amount)}
                </strong>{" "}
                (weighted {formatMoney(workspace.pipeline.translated.weighted)}). {workspace.pipeline.translated.label}{" "}
                {workspace.pipeline.translated.rates.map((rate) => `${rate.currencyCode} ${rate.rate}${rate.changed ? " (changed rate)" : rate.date ? ` from ${formatDate(rate.date)}` : ""}`).join(", ")}
              </p>
            ) : null}
            {workspace.accounting.notices.map((notice) => (
              <Notice key={notice} tone="warning">
                {notice}
              </Notice>
            ))}
            <h3 id="workspace-members">Organisations in the group on {formatDate(workspace.asAt)}</h3>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`} aria-labelledby="workspace-members">
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>In the group</th>
                    <th className={ui.num}>Revenue ({group.currencyCode})</th>
                    <th className={ui.num}>Net profit ({group.currencyCode})</th>
                    <th className={ui.num}>Customers owe (own currency)</th>
                    <th className={ui.num}>Open pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.members.map((member) => {
                    const books = workspace.accounting.perMember.find((entry) => entry.organisationId === member.organisationId);
                    return (
                      <tr key={member.organisationId}>
                        <td data-label="Organisation">
                          {member.name} ({member.currencyCode}) {member.isParent ? <Badge tone="blue">Parent</Badge> : null} {member.isSteward ? <Badge>Keeps the group&apos;s records</Badge> : null}
                          {member.error ? <div className={ui.error}>{member.error}</div> : null}
                        </td>
                        <td data-label="In the group">{stay(member)}</td>
                        <td data-label={`Revenue (${group.currencyCode})`} className={ui.num}>
                          {books ? <Money value={books.revenue} /> : <span className={ui.muted}>Not available</span>}
                        </td>
                        <td data-label={`Net profit (${group.currencyCode})`} className={ui.num}>
                          {books ? <Money value={books.netProfit} /> : <span className={ui.muted}>Not available</span>}
                        </td>
                        <td data-label="Customers owe" className={ui.num}>
                          {member.receivables === null ? <span className={ui.muted}>Accounting off</span> : `${member.currencyCode} ${formatMoney(member.receivables)}`}
                        </td>
                        <td data-label="Open pipeline" className={ui.num}>
                          <PerCurrency totals={member.pipeline} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className={ui.muted}>
              Revenue and net profit are the consolidated profit and loss from the group&apos;s year start, the same as the Profit and loss tab. Pipeline amounts are open opportunities as they stand now, excluding GST, in each company&apos;s currency.
              {workspace.fromCopy ? " Shown from a copy made in the last minute." : ""} Worked out {formatDateTime(workspace.computedAt)}.
            </p>
          </>
        ) : null}
      </Card>
      {workspace ? (
        <Card title="Pipeline by stage" description="Stages are combined only where they're the same in every organisation or someone mapped them (Customers tab).">
          {workspace.pipeline.byStage ? (
            workspace.pipeline.byStage.length === 0 ? (
              <Empty>No open opportunities.</Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={`${ui.table} ${ui.stackOnPhone}`}>
                  <thead>
                    <tr>
                      <th>Group stage</th>
                      <th className={ui.num}>Amount</th>
                      <th className={ui.num}>Weighted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspace.pipeline.byStage.map((entry) => (
                      <tr key={entry.groupStage}>
                        <td data-label="Group stage">{entry.groupStage}</td>
                        <td data-label="Amount" className={ui.num}>
                          <PerCurrency totals={entry.totals} />
                        </td>
                        <td data-label="Weighted" className={ui.num}>
                          <PerCurrency totals={entry.totals} weighted />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <Notice tone="warning">
              These stages are different between organisations and have no mapping, so the pipeline isn&apos;t combined by stage:{" "}
              {workspace.pipeline.unmappedStages.map((stage) => `${workspace.members.find((member) => member.organisationId === stage.organisationId)?.name ?? stage.organisationId}: ${stage.name}`).join("; ")}.
            </Notice>
          )}
        </Card>
      ) : null}
      {workspace ? <WorkspaceCustomers workspace={workspace} /> : null}
    </>
  );
}

function WorkspaceCustomers({ workspace }: { workspace: GroupWorkspace }) {
  return (
    <Card title="Linked customers" description="Only customers someone linked across organisations. Tohyee never links them because names or emails match.">
      {workspace.customers.items.length === 0 ? <Empty>No linked customers yet. Link them on the Customers tab.</Empty> : null}
      {workspace.customers.items.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Organisations</th>
                <th className={ui.num}>Open pipeline</th>
                <th className={ui.num}>Owes</th>
              </tr>
            </thead>
            <tbody>
              {workspace.customers.items.map((customer) => (
                <tr key={customer.id}>
                  <td data-label="Customer">{customer.name}</td>
                  <td data-label="Organisations">
                    {customer.links.map((link) => (
                      <div key={link.id}>
                        {link.organisationName}: {link.contactName ?? "contact not found"}
                        {link.inGroup ? "" : " (left the group, not in the totals)"}
                      </div>
                    ))}
                  </td>
                  <td data-label="Open pipeline" className={ui.num}>
                    <PerCurrency totals={customer.pipeline} />
                  </td>
                  <td data-label="Owes" className={ui.num}>
                    {customer.owed.length === 0 ? <span className={ui.muted}>Not available</span> : customer.owed.map((entry) => <div key={entry.currencyCode}>{`${entry.currencyCode} ${formatMoney(entry.amount)}`}</div>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

/** Search one member's contacts and pick one. */
function ContactPicker({ groupId, member, value, onChange }: { groupId: string; member: ConsolidationMember; value: string; onChange: (contactId: string) => void }) {
  const [q, setQ] = useState("");
  const found = useApiData<{ contacts: LinkableContact[] }>(`/api/consolidation/groups/${groupId}/contacts`, { organisationId: member.organisationId, q });
  return (
    <div className={ui.inlineForm}>
      <Field label={`Search ${member.name}`}>
        <input type="search" value={q} onChange={(event) => setQ(event.target.value)} maxLength={100} />
      </Field>
      <Field label={`Contact in ${member.name}`}>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Not linked</option>
          {(found.data?.contacts ?? []).map((contact) => (
            <option key={contact.id} value={contact.id} disabled={contact.linkedTo !== null}>
              {contact.name}
              {contact.email ? ` (${contact.email})` : ""}
              {contact.linkedTo ? `, already in ${contact.linkedTo}` : ""}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export function GroupCustomersTab({ group, canEdit, canAdmin }: { group: ConsolidationGroup; canEdit: boolean; canAdmin: boolean }) {
  const loaded = useApiData<GroupCustomers>(`/api/consolidation/groups/${group.id}/customers`);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<{ customerId: string; organisationId: string; contactId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked = Object.entries(chosen).filter(([, contactId]) => contactId !== "");
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      loaded.reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    }
  };
  return (
    <>
      <Card title="Customers across the group" description="Link the same customer's contact in each organisation to see them together. Each contact stays its own record in its own organisation.">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {loaded.data && loaded.data.hiddenLinks > 0 ? <Notice tone="warning">{loaded.data.hiddenLinks} link(s) to organisations that have left the group aren&apos;t shown, because you can&apos;t see them.</Notice> : null}
        {loaded.data && loaded.data.customers.length === 0 ? <Empty>No linked customers.</Empty> : null}
        {loaded.data?.customers.map((customer) => (
          <section key={customer.id} aria-label={customer.name}>
            <h3>{customer.name}</h3>
            <ul className={ui.relatedList}>
              {customer.links.map((link) => (
                <li key={link.id}>
                  {link.organisationName}: {link.contactName ?? "contact not found"}
                  {link.inGroup ? "" : " (left the group)"} <span className={ui.muted}>linked by {link.linkedByEmail}</span>{" "}
                  {canEdit ? (
                    <Button variant="secondary" size="small" onClick={() => void act(() => api(`/api/consolidation/groups/${group.id}/customers/${customer.id}/links/${link.id}`, { method: "DELETE" }))}>
                      Unlink
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canEdit ? (
              adding?.customerId === customer.id ? (
                <div>
                  <Field label="Organisation">
                    <select value={adding.organisationId} onChange={(event) => setAdding({ ...adding, organisationId: event.target.value, contactId: "" })}>
                      {group.members.map((member) => (
                        <option key={member.organisationId} value={member.organisationId}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ContactPicker
                    key={adding.organisationId}
                    groupId={group.id}
                    member={group.members.find((member) => member.organisationId === adding.organisationId)!}
                    value={adding.contactId}
                    onChange={(contactId) => setAdding({ ...adding, contactId })}
                  />
                  <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
                    <Button
                      disabled={!adding.contactId}
                      onClick={async () => {
                        if (await act(() => api(`/api/consolidation/groups/${group.id}/customers/${customer.id}/links`, { method: "POST", body: { organisationId: adding.organisationId, contactId: adding.contactId } }))) setAdding(null);
                      }}
                    >
                      Link contact
                    </Button>
                    <Button variant="secondary" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" size="small" onClick={() => setAdding({ customerId: customer.id, organisationId: group.members[0].organisationId, contactId: "" })}>
                  Link another contact
                </Button>
              )
            ) : null}
          </section>
        ))}
      </Card>
      {canEdit ? (
        <Card title="Link a customer" description="Choose the customer's contact in two or more of the organisations.">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const done = await act(() =>
                api(`/api/consolidation/groups/${group.id}/customers`, { method: "POST", body: { name, links: picked.map(([organisationId, contactId]) => ({ organisationId, contactId })) } }),
              );
              if (done) {
                setName("");
                setChosen({});
              }
            }}
          >
            <Field label="Name in the group">
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
            </Field>
            {group.members.map((member) => (
              <ContactPicker key={member.organisationId} groupId={group.id} member={member} value={chosen[member.organisationId] ?? ""} onChange={(contactId) => setChosen({ ...chosen, [member.organisationId]: contactId })} />
            ))}
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={picked.length < 2 || name.trim() === ""}>
                Link the customer
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <StageMappings group={group} canAdmin={canAdmin} />
    </>
  );
}

function StageMappings({ group, canAdmin }: { group: ConsolidationGroup; canAdmin: boolean }) {
  const loaded = useApiData<StageMappingView>(`/api/consolidation/groups/${group.id}/stage-mappings`);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const nameOf = (id: string) => group.members.find((member) => member.organisationId === id)?.name ?? id;
  const view = loaded.data;
  return (
    <Card title="Stage mappings" description="Which group stage each organisation's opportunity stages count as in the workspace. Stages that are the same everywhere are combined without one. Nothing in any organisation changes.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Saved.</Notice> : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {view && view.crmOff.length > 0 ? <Notice tone="info">The CRM is off in {view.crmOff.map(nameOf).join(", ")}.</Notice> : null}
      {view ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setSaved(false);
            try {
              await api(`/api/consolidation/groups/${group.id}/stage-mappings`, {
                method: "PUT",
                body: {
                  mappings: Object.entries(edits).map(([id, groupStage]) => {
                    const [organisationId, stageKey] = id.split("|");
                    return { organisationId, stageKey, groupStage };
                  }),
                },
              });
              setEdits({});
              setSaved(true);
              loaded.reload();
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        >
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Stage</th>
                  <th>Counts as</th>
                </tr>
              </thead>
              <tbody>
                {view.stages.map((stage) => {
                  const id = `${stage.organisationId}|${stage.key}`;
                  return (
                    <tr key={id}>
                      <td data-label="Organisation">{nameOf(stage.organisationId)}</td>
                      <td data-label="Stage">
                        {stage.name} <span className={ui.muted}>({stage.type})</span>
                      </td>
                      <td data-label="Counts as">
                        {canAdmin ? (
                          <input
                            aria-label={`${nameOf(stage.organisationId)} ${stage.name} counts as`}
                            value={edits[id] ?? (stage.how === "mapped" ? (stage.groupStage ?? "") : "")}
                            placeholder={stage.how === "same" ? `${stage.groupStage} (same everywhere)` : "Not mapped"}
                            maxLength={60}
                            onChange={(event) => setEdits({ ...edits, [id]: event.target.value })}
                          />
                        ) : (
                          (stage.groupStage ?? "Not mapped")
                        )}{" "}
                        {stage.how === "unmapped" ? <Badge tone="amber">Not mapped</Badge> : null}
                        {stage.how === "mapped" ? <span className={ui.muted}>by {stage.mappedByEmail}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canAdmin ? (
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={Object.keys(edits).length === 0}>
                Save mappings
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </Card>
  );
}

/** In the group's settings: when each member joined and left, and which one keeps the group's records. */
export function GroupMembershipCard({ group, canAdmin, onChanged }: { group: ConsolidationGroup; canAdmin: boolean; onChanged: () => void }) {
  const [dates, setDates] = useState<Record<string, { effectiveFrom: string; effectiveTo: string }>>({});
  const [steward, setSteward] = useState(group.stewardOrganisationId);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      setDates({});
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Members and their dates"
      description="Reports include the organisations in the group on their date. A report can't run across the day one joined or left. Saved reports keep the members they had."
    >
      <Notice tone="info">Being in this group isn&apos;t a tax consolidation election or a GST group. Those are separate arrangements with Inland Revenue.</Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Organisation</th>
              <th>First day</th>
              <th>Last day</th>
              {canAdmin ? <th>Change</th> : null}
            </tr>
          </thead>
          <tbody>
            {group.members.map((member) => {
              const fixed = member.organisationId === group.parentOrganisationId;
              const edit = dates[member.organisationId] ?? { effectiveFrom: member.effectiveFrom ?? "", effectiveTo: member.effectiveTo ?? "" };
              return (
                <tr key={member.organisationId}>
                  <td data-label="Organisation">
                    {member.name}
                    {fixed ? " (parent, always in)" : ""}
                    {member.organisationId === group.stewardOrganisationId ? " (keeps the records)" : ""}
                  </td>
                  <td data-label="First day">
                    {canAdmin && !fixed ? (
                      <DateInput aria-label={`${member.name} first day`} value={edit.effectiveFrom} onChange={(event) => setDates({ ...dates, [member.organisationId]: { ...edit, effectiveFrom: event.target.value } })} />
                    ) : member.effectiveFrom ? (
                      formatDate(member.effectiveFrom)
                    ) : (
                      "From the start"
                    )}
                  </td>
                  <td data-label="Last day">
                    {canAdmin && !fixed && member.organisationId !== group.stewardOrganisationId ? (
                      <DateInput aria-label={`${member.name} last day`} value={edit.effectiveTo} onChange={(event) => setDates({ ...dates, [member.organisationId]: { ...edit, effectiveTo: event.target.value } })} />
                    ) : member.effectiveTo ? (
                      formatDate(member.effectiveTo)
                    ) : (
                      "Still in"
                    )}
                  </td>
                  {canAdmin ? (
                    <td data-label="Change">
                      {!fixed ? (
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!dates[member.organisationId]}
                          onClick={() =>
                            void run(() =>
                              api(`/api/consolidation/groups/${group.id}/members`, {
                                method: "PUT",
                                body: { organisationId: member.organisationId, effectiveFrom: edit.effectiveFrom || null, effectiveTo: edit.effectiveTo || null, version: group.version },
                              }),
                            )
                          }
                        >
                          Save dates
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {group.formerMembers.length > 0 ? (
        <>
          <h3>Earlier members</h3>
          <ul className={ui.relatedList}>
            {group.formerMembers.map((member) => (
              <li key={`${member.organisationId}-${member.effectiveTo}`}>
                {member.name}: {stay(member)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canAdmin ? (
        <div className={ui.inlineForm}>
          <Field label="Keeps the group's records" hint="Customer links, stage mappings and saved reports are kept in this organisation's database.">
            <select value={steward} onChange={(event) => setSteward(event.target.value)}>
              {group.members.map((member) => (
                <option key={member.organisationId} value={member.organisationId}>
                  {member.name}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" disabled={steward === group.stewardOrganisationId} onClick={() => void run(() => api(`/api/consolidation/groups/${group.id}/steward`, { method: "PUT", body: { organisationId: steward, version: group.version } }))}>
            Change
          </Button>
        </div>
      ) : (
        <p className={ui.muted}>The group&apos;s records are kept by {group.members.find((member) => member.organisationId === group.stewardOrganisationId)?.name ?? "the parent"}.</p>
      )}
    </Card>
  );
}
