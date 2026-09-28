"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { TwoStepEnrol, TwoStepVerify } from "@/components/auth/two-step";
import { api, errorMessage } from "@/lib/client/api";
import { Button, Field, Notice } from "@/components/ui";
import styles from "./auth.module.css";

export type LoginStage = "password" | "verify" | "enrol";

type Props = {
  /** Where a session in progress is up to (after a reload part-way through). */
  initialStage?: LoginStage;
  initialEmail?: string;
  emailResetAvailable?: boolean;
};

export function LoginForm({ initialStage = "password", initialEmail = "", emailResetAvailable = false }: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<LoginStage>(initialStage);
  const [email, setEmail] = useState(initialEmail);
  const [canEmailReset, setCanEmailReset] = useState(emailResetAvailable);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function finish() {
    router.replace("/operations");
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ user: { email: string }; stage: "full" | "verify" | "enrol" }>("/api/auth/login", {
        method: "POST",
        body: { email: form.get("email"), password: form.get("password") },
      });
      if (result.stage === "full") {
        finish();
        return;
      }
      setEmail(result.user.email);
      if (result.stage === "verify") {
        const state = await api<{ emailResetAvailable: boolean }>("/api/auth/two-step");
        setCanEmailReset(state.emailResetAvailable);
      }
      setStage(result.stage);
      setBusy(false);
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
        {stage === "enrol" ? <TwoStepEnrol email={email} onDone={finish} /> : null}
        {stage === "verify" ? <TwoStepVerify email={email} emailResetAvailable={canEmailReset} onDone={finish} /> : null}
        {stage === "password" ? (
          <>
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
          </>
        ) : null}
      </div>
    </div>
  );
}
