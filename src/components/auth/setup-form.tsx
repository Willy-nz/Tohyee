"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Button, Field, Notice } from "@/components/ui";
import styles from "./auth.module.css";

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmPassword")) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ stage: "full" | "enrol" }>("/api/auth/setup", {
        method: "POST",
        body: {
          setupToken: form.get("setupToken"),
          displayName: form.get("displayName"),
          email: form.get("email"),
          password: form.get("password"),
        },
      });
      // With two-step sign-in, the new admin sets up an authenticator app first.
      router.replace(result.stage === "full" ? "/operations" : "/login");
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.brandDot} aria-hidden />
          Tohyee
        </div>
        <div>
          <h1 className={styles.title}>First-time setup</h1>
          <p className={styles.text}>
            Create the first server admin. You&apos;ll need the <code>SETUP_TOKEN</code> from the
            server&apos;s environment file; it proves you&apos;re the person who installed this server.
          </p>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
          <Field label="Setup token">
            <input name="setupToken" type="password" autoComplete="off" required autoFocus />
          </Field>
          <Field label="Your name">
            <input name="displayName" autoComplete="name" required />
          </Field>
          <Field label="Email">
            <input name="email" type="email" autoComplete="username" required />
          </Field>
          <Field label="Password" hint="At least 10 characters.">
            <input name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="Confirm password">
            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Setting up…" : "Create admin and sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
