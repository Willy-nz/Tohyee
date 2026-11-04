"use client";

import Link from "next/link";
import { useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { formatDate, todayInBrowser } from "@/lib/format";
import {
  accessUntilFor,
  HIRE_LENGTHS,
  HIRE_ROLES,
  HIRE_TASKS,
  type HireChoices,
  type HireFacts,
  type HireLength,
  type HireRole,
  type HireTask,
  inviteHref,
  ROLE_IN_BRIEF,
  writeBrief,
} from "@/lib/organisations/hire-brief";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (yearMonth: string) => `${MONTHS[Number(yearMonth.slice(5, 7)) - 1]} ${yearMonth.slice(0, 4)}`;

function FactsFromBooks({ facts }: { facts: HireFacts }) {
  const items = [
    facts.unreconciledLines > 0
      ? `${facts.unreconciledLines} bank lines not reconciled${facts.unreconciledFrom && facts.unreconciledTo ? `, ${month(facts.unreconciledFrom)} to ${month(facts.unreconciledTo)}` : ""}`
      : "All bank lines are reconciled",
    `${facts.bankAccounts} bank or card account${facts.bankAccounts === 1 ? "" : "s"}`,
    facts.gstRegistered
      ? `GST ${facts.gstPeriodMonths ? { 1: "monthly", 2: "two-monthly", 6: "six-monthly" }[facts.gstPeriodMonths] : "period not set"}, ${facts.gstBasis} basis`
      : "Not registered for GST",
    `Year ends in ${MONTHS[facts.financialYearEndMonth - 1]}`,
    ...(facts.employees !== null ? [`${facts.employees} employee${facts.employees === 1 ? "" : "s"}`] : []),
    facts.modules.length ? `On: ${facts.modules.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <div>
      <p className={ui.muted} style={{ marginBottom: 4 }}>
        From your books:
      </p>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function HireHelp({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const facts = useApiData<{ facts: HireFacts }>(can("admin") ? `/api/organisations/${organisationId}/hire-facts` : null);
  const [choices, setChoices] = useState<HireChoices>(() => ({
    tasks: ["bank_reconciliation"],
    catchUpMonths: 3,
    role: "bookkeeper",
    startDate: todayInBrowser(),
    length: "1_month",
    untilDate: "",
  }));
  const [edited, setEdited] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can invite people, so only they can use this.</Notice>;
  if (facts.error) return <Notice tone="error">{facts.error}</Notice>;
  if (!facts.data) return <p className={ui.muted}>Loading…</p>;
  const data = facts.data.facts;

  const set = (patch: Partial<HireChoices>) => {
    setChoices({ ...choices, ...patch });
    setCopied(false);
  };
  const toggle = (task: HireTask, on: boolean) => set({ tasks: on ? [...choices.tasks, task] : choices.tasks.filter((entry) => entry !== task) });
  const generated = writeBrief(data, choices);
  const text = edited ?? generated;
  const until = accessUntilFor(choices.startDate, choices.length, choices.untilDate);
  const datesOk = Boolean(choices.startDate && until && until >= choices.startDate);

  return (
    <>
      <p>
        <Link href="/operations/members">Back to People and roles</Link>
      </p>
      <Card title="1. What needs doing" description="Tick everything you want help with.">
        <FactsFromBooks facts={data} />
        <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
          <legend className={ui.fieldLabel}>Tasks</legend>
          {HIRE_TASKS.map((task) => (
            <div key={task.key} style={{ marginBottom: 8 }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={choices.tasks.includes(task.key)} onChange={(event) => toggle(task.key, event.target.checked)} />
                <span>
                  {task.label}
                  <span className={ui.muted} style={{ display: "block", fontSize: "0.9em" }}>
                    {task.help}
                  </span>
                </span>
              </label>
              {task.key === "catch_up" && choices.tasks.includes("catch_up") ? (
                <div style={{ marginLeft: 26, maxWidth: 200 }}>
                  <Field label="How many months">
                    <input type="number" min={1} max={60} value={choices.catchUpMonths} onChange={(event) => set({ catchUpMonths: Math.max(1, Math.min(60, Number(event.target.value) || 1)) })} />
                  </Field>
                </div>
              ) : null}
            </div>
          ))}
        </fieldset>
      </Card>

      <Card title="2. Access and how long" description="They get their own login. Their access stops by itself at the end.">
        <div className={ui.inlineForm}>
          <Field label="Access" hint={ROLE_IN_BRIEF[choices.role]}>
            <select value={choices.role} onChange={(event) => set({ role: event.target.value as HireRole })}>
              {HIRE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Starting">
            <DateInput value={choices.startDate} onChange={(event) => set({ startDate: event.target.value })} />
          </Field>
          <Field label="For" hint={datesOk ? `Until the end of ${formatDate(until)}.` : "Choose when it ends."}>
            <select value={choices.length} onChange={(event) => set({ length: event.target.value as HireLength })}>
              {HIRE_LENGTHS.map((length) => (
                <option key={length.key} value={length.key}>
                  {length.label}
                </option>
              ))}
            </select>
          </Field>
          {choices.length === "custom" ? (
            <Field label="Until">
              <DateInput value={choices.untilDate} onChange={(event) => set({ untilDate: event.target.value })} />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card
        title="3. Your brief"
        description={
          <>
            Check it, change anything you like, then copy it and post it on the hiring site you use.{" "}
            <InfoTip label="What's in the brief">
              Only counts and periods from your books go in. It never has your organisation&apos;s name, customers,
              suppliers, amounts or bank details. Read it before you post it: anything you type in yourself goes with it.
            </InfoTip>
          </>
        }
      >
        <Field label="Brief">
          <textarea
            value={text}
            rows={20}
            style={{ width: "100%", fontFamily: "inherit" }}
            onChange={(event) => {
              setEdited(event.target.value);
              setCopied(false);
            }}
          />
        </Field>
        {edited !== null && edited !== generated ? (
          <Notice tone="warning">
            You&apos;ve changed the text, so changes to your choices above won&apos;t show.{" "}
            <Button variant="secondary" size="small" onClick={() => setEdited(null)}>
              Start again from my choices
            </Button>
          </Notice>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            Copy brief
          </Button>
          {copied ? <span role="status">Copied. Post it on the hiring site you use.</span> : null}
        </div>
      </Card>

      <Card title="4. When you've chosen someone" description="Invite them with the access and dates above. You can change the dates later.">
        {datesOk ? (
          <Link className={`${ui.button} ${ui.primary}`} href={inviteHref(choices)}>
            Invite them
          </Link>
        ) : (
          <Notice tone="warning">Choose when their access ends first.</Notice>
        )}
      </Card>
    </>
  );
}

export default function HireHelpPage() {
  return (
    <Page>
      <PageHeader title="Hire help" />
      <RequireOrganisation>{(organisationId) => <HireHelp key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
