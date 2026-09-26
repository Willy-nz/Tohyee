"use client";

import { type FormEvent, useState } from "react";
import { Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";

export default function ProfilePage() {
  const { user, organisations } = useWorkspace();
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("newPassword") !== form.get("confirmPassword")) {
      setStatus({ tone: "error", text: "The new passwords don't match." });
      return;
    }
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") },
      });
      formElement.reset();
      setStatus({ tone: "success", text: "Password changed. Your other sessions have been signed out." });
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <Page>
      <PageHeader title="Your account" description={`${user.displayName} · ${user.email}${user.isServerAdmin ? " · server admin" : ""}`} />
      <Card title="Organisations you can open">
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Your role</th>
                <th>Base currency</th>
              </tr>
            </thead>
            <tbody>
              {organisations.map((organisation) => (
                <tr key={organisation.id}>
                  <td>{organisation.displayName}</td>
                  <td>{ROLE_LABELS[organisation.role]}</td>
                  <td>{organisation.baseCurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Change password">
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
        <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12, maxWidth: 420 }}>
          <Field label="Current password">
            <input name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="Confirm new password">
            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <div>
            <Button type="submit">Change password</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}
