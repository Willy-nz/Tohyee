"use client";

import Link from "next/link";
import { useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { DuplicatePair } from "@/lib/crm/duplicates";

const REASONS: Record<string, string> = { name: "Same name", email: "Same email", phone: "Same phone" };

type Side = DuplicatePair["first"];

function recordHref(record: DuplicatePair["record"], id: string): string {
  return record === "company" ? `/crm/companies/${id}` : `/crm/people/${id}`;
}

function PairRow({
  organisationId,
  pair,
  canMerge,
  onChanged,
}: {
  organisationId: string;
  pair: DuplicatePair;
  canMerge: boolean;
  onChanged: () => void;
}) {
  const { canCrm } = useWorkspace();
  const { busy, error, run } = useBusy();
  const [keeping, setKeeping] = useState<Side | null>(null);
  const writer = canCrm("write");
  const sides = [pair.first, pair.second];
  const other = (side: Side) => (side.id === pair.first.id ? pair.second : pair.first);
  const review = (decision: "not_duplicate" | "same_customer") =>
    void run(async () => {
      await api("/api/crm/duplicates/review", { method: "POST", body: { organisationId, record: pair.record, firstId: pair.first.id, secondId: pair.second.id, decision } });
      onChanged();
    });
  const merge = (keep: Side) =>
    void run(async () => {
      await api("/api/crm/duplicates/merge", { method: "POST", body: { organisationId, record: pair.record, keepId: keep.id, mergeId: other(keep).id } });
      setKeeping(null);
      onChanged();
    });
  const bothBooks = pair.record === "company" && pair.first.hasBooks && pair.second.hasBooks;
  return (
    <div style={{ display: "grid", gap: 8, padding: "10px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "baseline" }}>
        <Badge>{REASONS[pair.reason] ?? pair.reason}</Badge>
        {sides.map((side) => (
          <span key={side.id}>
            <Link href={recordHref(pair.record, side.id)}>{side.name}</Link>
            {side.detail ? <span className={ui.muted}> · {side.detail}</span> : null}
            {side.hasBooks ? <span className={ui.muted}> · has accounting records</span> : null}
          </span>
        ))}
      </div>
      {keeping ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span>
            Keep <strong>{keeping.name}</strong> and merge <strong>{other(keeping).name}</strong> into it?{" "}
            {pair.record === "company"
              ? "Its people, deals, tasks and activities move across; it's archived, and its notes and files stay on it."
              : "Their deals, tasks and activities move across, and they're archived."}
          </span>
          <Button size="small" disabled={busy} onClick={() => merge(keeping)}>
            Merge
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => setKeeping(null)}>
            Cancel
          </Button>
        </div>
      ) : writer ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {canMerge && pair.canMerge
            ? sides
                // Only a company with no accounting records can be merged away.
                .filter((side) => !other(side).hasBooks)
                .map((side) => (
                  <Button key={side.id} size="small" variant="secondary" disabled={busy} onClick={() => setKeeping(side)}>
                    Keep {side.name}
                  </Button>
                ))
            : null}
          {bothBooks ? (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => review("same_customer")}>
              Same customer
            </Button>
          ) : null}
          <Button size="small" variant="secondary" disabled={busy} onClick={() => review("not_duplicate")}>
            Not duplicates
          </Button>
        </div>
      ) : null}
      {pair.record === "person" && !pair.canMerge ? <span className={ui.muted}>They&apos;re at different companies, so they can&apos;t be merged.</span> : null}
      {bothBooks ? <span className={ui.muted}>Both have accounting records, so they can&apos;t be merged; mark them as the same customer to link them.</span> : null}
    </div>
  );
}

/**
 * CRM › Duplicates (decision 494): companies and people that look alike.
 * A company with no accounting records can be merged into the other; two
 * that both have them can only be linked as the same customer.
 */
export function DuplicatesPage({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ pairs: DuplicatePair[]; canMerge: boolean }>("/api/crm/duplicates", { organisationId });
  const pairs = data.data?.pairs ?? [];
  const section = (record: DuplicatePair["record"], title: string, description: string) => {
    const shown = pairs.filter((pair) => pair.record === record);
    return (
      <Card title={title} description={description}>
        {data.data && shown.length === 0 ? <Empty>No likely duplicates.</Empty> : null}
        {shown.map((pair) => (
          <PairRow key={`${pair.first.id}:${pair.second.id}`} organisationId={organisationId} pair={pair} canMerge={data.data?.canMerge ?? false} onChanged={data.reload} />
        ))}
      </Card>
    );
  };
  return (
    <>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {data.data && !data.data.canMerge ? <Notice>Merging needs the bookkeeper role or higher; you can mark pairs as not duplicates.</Notice> : null}
      {section("company", "Companies", "Same name (ignoring Ltd, Limited and punctuation), email or phone.")}
      {section("person", "People", "Same email, or the same name at the same company.")}
    </>
  );
}
