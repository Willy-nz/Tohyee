"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { PayrollAccessPerson } from "@/lib/payroll/access";

/** Shown instead of payroll data to someone without payroll access (example PR10). */
export const NO_PAYROLL_ACCESS =
  "You need payroll access to see payroll. Ask an admin to give it to you in Settings › Payroll access.";

/**
 * Shows `children` only to people with payroll access; everyone else sees a
 * short message and no data (PR10). The APIs refuse them too.
 */
export function PayrollAccessGate({ organisationId, children }: { organisationId: string; children: ReactNode }) {
  const { data, error, loading } = useApiData<{ hasPayrollAccess: boolean; canManagePayrollAccess: boolean }>(
    "/api/payroll/access/me",
    { organisationId },
  );
  if (loading) return <Empty>Checking payroll access…</Empty>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data?.hasPayrollAccess) {
    return (
      <Notice tone="warning">
        {NO_PAYROLL_ACCESS}
        {data?.canManagePayrollAccess ? (
          <>
            {" "}
            <Link href="/operations/settings/payroll-access">Open Payroll access</Link>
          </>
        ) : null}
      </Notice>
    );
  }
  return <>{children}</>;
}

const ROLE_LABELS: Record<PayrollAccessPerson["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  bookkeeper: "Bookkeeper",
  viewer: "Viewer",
};

/** Settings › Payroll access, for admins (PR11). */
export function PayrollAccessSettings({ organisationId }: { organisationId: string }) {
  const { data, error, loading, reload } = useApiData<{ people: PayrollAccessPerson[] }>("/api/payroll/access", { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const change = async (person: PayrollAccessPerson, give: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/payroll/access", { method: "PUT", body: { organisationId, userId: person.userId, hasPayrollAccess: give } });
      setMessage({
        tone: "success",
        text: give ? `${person.displayName || person.email} now has payroll access.` : `Payroll access removed from ${person.displayName || person.email}.`,
      });
      reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Who can see payroll">
      <p>
        Payroll access lets someone see and change employees&apos; pay, cost allocations, pay rates, IRD numbers and bank accounts.
        It&apos;s separate from their role: admins need it too, and it can only be given to bookkeepers or higher. At least one
        person must keep it. Every change goes in the audit log.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? (
        <Empty>Loading people…</Empty>
      ) : data?.people.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Payroll access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((person) => (
                <tr key={person.userId}>
                  <td data-label="Person">
                    {person.displayName || person.email}
                    <br />
                    <small>{person.email}</small>
                  </td>
                  <td data-label="Role">{ROLE_LABELS[person.role]}</td>
                  <td data-label="Payroll access">
                    {person.hasPayrollAccess ? (
                      <>
                        <Badge tone="green">Yes</Badge>
                        <br />
                        <small>
                          Given {formatDateTime(person.grantedAt)} by{" "}
                          {person.grantedByEmail === "system" ? "Tohyee (first owner)" : person.grantedByEmail}
                        </small>
                      </>
                    ) : (
                      <Badge tone="neutral">No</Badge>
                    )}
                  </td>
                  <td data-label="Actions">
                    {person.hasPayrollAccess ? (
                      <Button disabled={busy} size="small" variant="secondary" onClick={() => void change(person, false)}>
                        Remove access
                      </Button>
                    ) : person.role === "viewer" ? (
                      <small>Viewers can&apos;t have payroll access.</small>
                    ) : (
                      <Button disabled={busy} size="small" onClick={() => void change(person, true)}>
                        Give access
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No people found.</Empty>
      )}
    </Card>
  );
}
