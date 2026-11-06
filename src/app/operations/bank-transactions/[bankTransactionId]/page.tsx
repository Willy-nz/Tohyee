"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Notice, Page, ui } from "@/components/ui";
import type { BankTransaction } from "@/lib/bank/transactions";

/** Opens one bank transaction where it can be recoded: its bank account's Transactions tab (decision 1565). */
function OpenTransaction({ organisationId, bankTransactionId }: { organisationId: string; bankTransactionId: string }) {
  const router = useRouter();
  const found = useApiData<{ bankTransaction: BankTransaction }>(`/api/bank-transactions/${bankTransactionId}`, { organisationId });
  const accountId = found.data?.bankTransaction.accountId;
  useEffect(() => {
    if (accountId) router.replace(`/operations/bank-accounts/${accountId}?tab=transactions&transaction=${encodeURIComponent(bankTransactionId)}`);
  }, [accountId, bankTransactionId, router]);
  if (found.error) return <Notice tone="error">{found.error}</Notice>;
  return <p className={ui.muted}>Opening the bank transaction…</p>;
}

export default function BankTransactionPage() {
  const { bankTransactionId } = useParams<{ bankTransactionId: string }>();
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <OpenTransaction key={organisationId} organisationId={organisationId} bankTransactionId={bankTransactionId} />}</RequireOrganisation>
    </Page>
  );
}
