"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { BrandMark } from "@/components/brand-mark";
import styles from "./auth.module.css";

/** An emailed reset link: the password again, then two-step sign-in is set up afresh. */
export function ResetTwoStepForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/two-step/reset", { method: "POST", body: { token, password } });
      router.replace("/login");
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
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        <div>
          <h1 className={styles.title}>Reset two-step sign-in</h1>
          <p className={styles.text}>
            Enter your password. Your old authenticator app and backup codes stop working, you&apos;re signed out everywhere, and you set up
            your authenticator app again straight away.
          </p>
        </div>
        {!token ? <Notice tone="error">This link is missing its code. Open the link from the email again.</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
          <Field label="Password">
            <input name="password" type="password" autoComplete="current-password" required autoFocus />
          </Field>
          <Button type="submit" disabled={busy || !token}>
            {busy ? "Resetting…" : "Reset and set up again"}
          </Button>
        </form>
      </div>
    </div>
  );
}
