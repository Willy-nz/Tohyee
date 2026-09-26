"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Button, Field, Notice } from "@/components/ui";
import styles from "./auth.module.css";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: { email: form.get("email"), password: form.get("password") },
      });
      router.replace("/operations");
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
          Toeyee
        </div>
        <div>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.text}>Use the email and password your server admin set up for you.</p>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
          <Field label="Email">
            <input name="email" type="email" autoComplete="username" required autoFocus />
          </Field>
          <Field label="Password">
            <input name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className={styles.text}>
          Forgotten your password? A server admin can reset it from Users, or on the server with{" "}
          <code>npm run admin -- set-password</code>.
        </p>
      </div>
    </div>
  );
}
