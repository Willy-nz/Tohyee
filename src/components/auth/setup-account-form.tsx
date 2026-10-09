"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { SetupLinkState } from "@/lib/auth/setup-links";
import styles from "./auth.module.css";

/** A setup link (#208): choose a password, then set up two-step sign-in straight away. */
export function SetupAccountForm({ token }: { token: string }) {
  const router = useRouter();
  const link = useApiData<SetupLinkState>(token ? "/api/auth/setup-account" : null, { token });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("again") ?? "")) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/setup-account", { method: "POST", body: { token, password } });
      router.replace("/login");
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  const invalid = !token || (link.data && !link.data.valid);
  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        <div>
          <h1 className={styles.title}>Set up your login</h1>
          <p className={styles.text}>
            {link.data?.valid ? `For ${link.data.email}. ` : ""}Choose a password (at least 10 characters). Then you&apos;ll set up two-step
            sign-in with an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator.
          </p>
        </div>
        {!token ? <Notice tone="error">This link is missing its code. Open the link you were sent again.</Notice> : null}
        {token && link.data && !link.data.valid ? (
          <Notice tone="error">This setup link has expired or was already used. Ask your server admin for a new one.</Notice>
        ) : null}
        {link.error ? <Notice tone="error">{link.error}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
          <Field label="Password">
            <input name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
          </Field>
          <Field label="Password again">
            <input name="again" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Button type="submit" disabled={busy || Boolean(invalid)}>
            {busy ? "Setting up…" : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
