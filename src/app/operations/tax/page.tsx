"use client";

import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import { dec, divide, mul, toPlainString } from "@/lib/money/decimal";
import { TAX_CATEGORIES, type TaxCategory } from "@/lib/tax/categories";
import type { TaxCode } from "@/lib/tax/codes";

const CATEGORY_LABELS: Record<TaxCategory, string> = {
  standard: "Standard rated",
  zero_rated: "Zero rated",
  exempt: "Exempt",
  out_of_scope: "Out of scope",
};

function percent(rate: string): string {
  return `${toPlainString(mul(dec(rate), dec("100")))}%`;
}

function Tax({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const codes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const [form, setForm] = useState({ code: "", label: "", category: "standard" as TaxCategory, percent: "15", effectiveFrom: todayInBrowser() });
  const [key, setKey] = useState(() => newIdempotencyKey("tax"));
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = form.percent.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      setStatus({ tone: "error", text: "Enter the rate as a percentage, like 15." });
      return;
    }
    const rate = toPlainString(divide(dec(trimmed), dec("100"), 6));
    try {
      await api("/api/tax/codes", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: key,
          source: "ui",
          code: form.code,
          label: form.label,
          category: form.category,
          rate: form.category === "standard" ? rate : "0",
          effectiveFrom: form.effectiveFrom,
        },
      });
      setKey(newIdempotencyKey("tax"));
      setStatus({ tone: "success", text: `Added tax code ${form.code.toUpperCase()}.` });
      setForm((current) => ({ ...current, code: "", label: "" }));
      codes.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <>
      <Notice tone="info">
        Tax codes are set up here ready for GST. They aren&apos;t applied to journals yet, so GST returns aren&apos;t calculated in
        Toeyee for now.
      </Notice>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {can("admin") ? (
        <Card title="Add a tax code">
          <form className={ui.inlineForm} onSubmit={(event) => void submit(event)}>
            <Field label="Code">
              <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={20} required />
            </Field>
            <Field label="Name">
              <input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} maxLength={100} required />
            </Field>
            <Field label="Type">
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as TaxCategory })}>
                {TAX_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            </Field>
            {form.category === "standard" ? (
              <Field label="Rate (%)">
                <input inputMode="decimal" value={form.percent} onChange={(event) => setForm({ ...form, percent: event.target.value })} required />
              </Field>
            ) : null}
            <Field label="Effective from">
              <input type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} required />
            </Field>
            <Button type="submit">Add</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Tax codes">
        {codes.error ? <Notice tone="error">{codes.error}</Notice> : null}
        {codes.data && codes.data.taxCodes.length === 0 ? (
          <Empty>No tax codes yet. For New Zealand GST, add GST at 15% (standard rated) and a zero-rated code.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className={ui.num}>Rate</th>
                  <th>Effective</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(codes.data?.taxCodes ?? []).map((code) => (
                  <tr key={code.id}>
                    <td>{code.code}</td>
                    <td>{code.label}</td>
                    <td>{CATEGORY_LABELS[code.category]}</td>
                    <td className={ui.num}>{percent(code.rate)}</td>
                    <td>
                      {formatDate(code.effectiveFrom)}
                      {code.effectiveTo ? ` to ${formatDate(code.effectiveTo)}` : ""}
                    </td>
                    <td>{code.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function TaxPage() {
  return (
    <Page>
      <PageHeader title="Tax codes" />
      <RequireOrganisation>{(organisationId) => <Tax key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
