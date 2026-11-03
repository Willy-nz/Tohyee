"use client";

import { InfoTip } from "@/components/info-tip";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, ui } from "@/components/ui";
import type { StatementLine } from "@/lib/bank/accounts";
import { formatDate } from "@/lib/format";
import { type PayoutCandidate, type PayoutMatchStatus, settlementRows } from "@/lib/sales-platforms/payout-match";
import type { LinePayoutGuidance } from "@/lib/sales-platforms/payout-reconcile";

/**
 * The payout guide on a bank line (#548, SPR1-SPR10): which platform payout
 * the deposit is, its settlement, and one button for the reconcile the
 * person reviews (the screen's ordinary match or transfer). Shows nothing
 * for a line that isn't a payout.
 */

const BADGES: Record<PayoutMatchStatus, { tone: "green" | "amber" | "red" | "neutral"; text: string }> = {
  matched: { tone: "green", text: "Payout found" },
  combined: { tone: "green", text: "Payouts found" },
  needs_choice: { tone: "amber", text: "Check the payout" },
  already_matched: { tone: "red", text: "Already matched" },
  payout_not_posted: { tone: "amber", text: "Payout not in the accounts" },
  missing_posting_setup: { tone: "amber", text: "Setup needed" },
  missing_settlement_data: { tone: "amber", text: "No payout details" },
  unmatched: { tone: "neutral", text: "No payout matches" },
};

function Settlement({ payout }: { payout: PayoutCandidate }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong>
        {payout.platformLabel} payout {payout.externalId}{" "}
        <span className={ui.muted} style={{ fontWeight: "normal" }}>
          {formatDate(payout.issuedOn)}
        </span>
      </strong>
      {payout.settlement ? (
        <table className={ui.table} style={{ maxWidth: 360 }}>
          <tbody>
            {settlementRows(payout.settlement).map((row) => (
              <tr key={row.label}>
                <td>{row.label === "Net payout" ? <strong>{row.label}</strong> : row.label}</td>
                <td className={ui.num}>
                  <Money value={row.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className={ui.muted}>
          Net <Money value={payout.net} />. No breakdown kept.
        </span>
      )}
      {payout.ordersNotInBooks.length > 0 ? (
        <span className={ui.muted}>Not in the books: {payout.ordersNotInBooks.join(", ")}</span>
      ) : null}
    </div>
  );
}

export function PayoutGuide({
  organisationId,
  line,
  submit,
  busy,
}: {
  organisationId: string;
  line: StatementLine;
  submit: (command: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const detail = useApiData<{ guidance: LinePayoutGuidance }>(`/api/statement-lines/${line.id}/payout`, { organisationId });
  const guidance = detail.data?.guidance;
  if (!guidance) return null;
  const badge = BADGES[guidance.status];
  const action = guidance.action;
  return (
    <section className={ui.suggestion} aria-label={`${guidance.platformLabel} payout`} style={{ display: "grid", gap: 8 }}>
      <div>
        <Badge tone={badge.tone}>{badge.text}</Badge>{" "}
        <InfoTip label="About payout matching">
          Matched by the payout number on the line, or by {guidance.platformLabel}&apos;s name, amount and date. Never by amount alone.
          Sales and fees are already posted, so matching posts nothing new. {guidance.gst.note}
        </InfoTip>
      </div>
      <p style={{ margin: 0 }}>{guidance.reason}</p>
      {guidance.payouts.length > 0 && guidance.status !== "unmatched" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {guidance.payouts.map((payout) => (
            <Settlement key={payout.externalId} payout={payout} />
          ))}
        </div>
      ) : null}
      {action ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button size="small" disabled={busy} onClick={() => void submit({ ...action })}>
            {action.kind === "match" ? (guidance.payouts.length > 1 ? "Match payouts" : "Match payout") : `Transfer from ${action.otherAccountCode}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
