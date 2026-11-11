"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Notice, ui } from "@/components/ui";
import type { StatementLine } from "@/lib/bank/accounts";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { SettlementGuidance } from "@/lib/sales-platforms/gateway-settlements";

const BADGES: Record<SettlementGuidance["status"], { tone: "green" | "amber" | "neutral"; text: string }> = {
  matched: { tone: "green", text: "Settlement found" },
  needs_choice: { tone: "amber", text: "Choose the order" },
  unmatched: { tone: "neutral", text: "No order fits" },
};

/**
 * A payment gateway's deposit on a bank line (GS1-GS4, decision 1591): the
 * order payments in the gateway's clearing account it settles, and one
 * button that reconciles the line as a transfer from that account and posts
 * the fee. Shows nothing for a line that doesn't name a gateway.
 */
export function GatewaySettlementGuide({ organisationId, line, onDone }: { organisationId: string; line: StatementLine; onDone: () => void }) {
  const detail = useApiData<{ guidance: SettlementGuidance | null }>(`/api/statement-lines/${line.id}/gateway-settlement`, { organisationId });
  const [key, setKey] = useState(() => newIdempotencyKey("gateway-settlement"));
  const [chosen, setChosen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guidance = detail.data?.guidance;
  if (!guidance) return null;
  const label = guidance.gateway.title ?? guidance.gateway.method;
  const choice = guidance.choices[chosen] ?? guidance.choices[0];

  async function settle() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/statement-lines/${line.id}/gateway-settlement`, {
        method: "POST",
        body: { organisationId, idempotencyKey: key, paymentIds: choice.payments.map((payment) => payment.paymentId) },
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setKey(newIdempotencyKey("gateway-settlement"));
    } finally {
      setBusy(false);
    }
  }

  const badge = BADGES[guidance.status];
  return (
    <section
      className={ui.suggestion}
      aria-label={`${label} settlement`}
      style={{ display: "grid", gap: 8, maxWidth: "min(720px, calc(100vw - 80px))", boxSizing: "border-box", whiteSpace: "normal" }}
    >
      <div>
        <Badge tone={badge.tone}>{badge.text}</Badge>{" "}
        <InfoTip label="About gateway settlements">
          Found by {label}&apos;s name on the line, then the order payments in {guidance.gateway.accountCode} from the 14 days before whose total, less a fee
          of up to 10% plus 1.00, is the deposit. Never by amount alone. {guidance.gstNote}
        </InfoTip>
      </div>
      <p style={{ margin: 0 }}>{guidance.reason}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {guidance.choices.length > 0 ? (
        <table className={ui.table} style={{ maxWidth: 520 }}>
          <thead>
            <tr>
              {guidance.choices.length > 1 ? <th aria-label="Choose" /> : null}
              <th>Order</th>
              <th>Paid</th>
              <th className={ui.num}>Settled</th>
              <th className={ui.num}>Fee</th>
            </tr>
          </thead>
          <tbody>
            {guidance.choices.map((option, index) => (
              <tr key={option.payments.map((payment) => payment.paymentId).join("-")}>
                {guidance.choices.length > 1 ? (
                  <td>
                    <input
                      type="radio"
                      name={`settle-${line.id}`}
                      checked={chosen === index}
                      onChange={() => setChosen(index)}
                      aria-label={`Choose ${option.payments.map((payment) => payment.orderName ?? payment.paymentId).join(" and ")}`}
                    />
                  </td>
                ) : null}
                <td>{option.payments.map((payment) => payment.orderName ?? `Payment ${payment.paymentId}`).join(", ")}</td>
                <td>{option.payments.map((payment) => formatDate(payment.date)).join(", ")}</td>
                <td className={ui.num}>
                  <Money value={option.settled} />
                </td>
                <td className={ui.num}>
                  <Money value={option.fee} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {choice ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button size="small" disabled={busy || !guidance.feesAccountCode} onClick={() => void settle()}>
            {busy ? "Settling…" : `Transfer from ${guidance.gateway.accountCode}, fee to ${guidance.feesAccountCode ?? "?"}`}
          </Button>
          {!guidance.feesAccountCode ? <span className={ui.muted}>Choose the store&apos;s fees account in its settings first.</span> : null}
        </div>
      ) : null}
    </section>
  );
}
