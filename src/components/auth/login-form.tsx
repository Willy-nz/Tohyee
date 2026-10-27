"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GoogleButton } from "@/components/auth/google-button";
import { cancelPasskeyPrompt, passkeyAutofillSupported, passkeysSupported, signInWithPasskey } from "@/components/auth/passkey-client";
import { TwoStepEnrol, TwoStepVerify } from "@/components/auth/two-step";
import { api, errorMessage } from "@/lib/client/api";
import { Button, Field, Notice } from "@/components/ui";
import { BrandMark } from "@/components/brand-mark";
import styles from "./auth.module.css";

export type LoginStage = "password" | "verify" | "enrol";

type Props = {
  /** Where to go once signed in (checked by the login page). */
  next?: string;
  /** Where a session in progress is up to (after a reload part-way through). */
  initialStage?: LoginStage;
  initialEmail?: string;
  emailResetAvailable?: boolean;
  /** Sign in with Google is on for this server (#424). */
  googleAvailable?: boolean;
  /** What the Google sign-in said, on the way back from it. */
  googleMessage?: string | null;
  /** Passkeys work on the address in use (#450). */
  passkeyAvailable?: boolean;
  /** Why passkeys don't work on this address (shown once anyone here has a passkey). */
  passkeyProblem?: string | null;
};

/** A key, for the passkey button. */
function PasskeyMark() {
  return (
    <svg className={styles.passkeyMark} viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5 21v-3a4 4 0 0 1 4-4h2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17.5" cy="11.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M17.5 14v6l1.5-1.2M17.5 17.5H19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const noSubscribe = () => () => {};

/** A waiting autofill prompt is started again this often, inside the 5 minutes its challenge lasts. */
const AUTOFILL_RESTART_MS = 4 * 60 * 1000;

export function LoginForm({
  next = "/operations",
  initialStage = "password",
  initialEmail = "",
  emailResetAvailable = false,
  googleAvailable = false,
  googleMessage = null,
  passkeyAvailable = false,
  passkeyProblem = null,
}: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<LoginStage>(initialStage);
  const [email, setEmail] = useState(initialEmail);
  const [canEmailReset, setCanEmailReset] = useState(emailResetAvailable);
  const [error, setError] = useState<string | null>(googleMessage);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // Whether this browser can use passkeys at all (false while rendering on the server).
  const canPasskey = useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
  const autofillOn = useRef(false);
  const buttonActive = useRef(false);
  const restartAutofill = useRef<() => void>(() => undefined);

  function finish() {
    router.replace(next);
    router.refresh();
  }

  // Passkeys in the email box's suggestions (where the browser offers them), and the button where it can use them at all.
  useEffect(() => {
    if (!passkeyAvailable || stage !== "password") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function listen() {
      if (stopped || !(await passkeyAutofillSupported())) return;
      autofillOn.current = true;
      timer = setTimeout(() => {
        cancelPasskeyPrompt();
      }, AUTOFILL_RESTART_MS);
      const outcome = await signInWithPasskey(true);
      clearTimeout(timer);
      autofillOn.current = false;
      if (stopped) return;
      if (outcome.ok) {
        finish();
        return;
      }
      if (outcome.message) setError(outcome.message);
      // Closed, timed out, or failed: wait for the next pick (unless the button's prompt took over).
      if (!buttonActive.current) void listen();
    }
    restartAutofill.current = () => {
      if (!stopped && !autofillOn.current) void listen();
    };
    void listen();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (autofillOn.current) cancelPasskeyPrompt();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passkeyAvailable, stage]);

  async function passkey() {
    setPasskeyBusy(true);
    setError(null);
    // The button's prompt replaces the autofill one, which starts again afterwards.
    buttonActive.current = true;
    const outcome = await signInWithPasskey(false);
    buttonActive.current = false;
    if (outcome.ok) {
      finish();
      return;
    }
    if (outcome.message) setError(outcome.message);
    setPasskeyBusy(false);
    restartAutofill.current();
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
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        {stage === "enrol" ? <TwoStepEnrol email={email} onDone={finish} /> : null}
        {stage === "verify" ? <TwoStepVerify email={email} emailResetAvailable={canEmailReset} onDone={finish} /> : null}
        {stage === "password" ? (
          <>
            <div>
              <h1 className={styles.title}>Sign in</h1>
              <p className={styles.text}>
                {next.startsWith("/connect/") ? "Sign in to connect your AI app. " : ""}Use the email and password your server admin set up for you.
              </p>
            </div>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
              <Field label="Email">
                <input name="email" type="email" autoComplete={passkeyAvailable ? "username webauthn" : "username"} required autoFocus />
              </Field>
              <Field label="Password">
                <input name="password" type="password" autoComplete="current-password" required />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
            {googleAvailable || (passkeyAvailable && canPasskey) ? <div className={styles.divider}>or</div> : null}
            {passkeyAvailable && canPasskey ? (
              <Button type="button" variant="secondary" className={styles.googleButton} disabled={passkeyBusy} onClick={() => void passkey()}>
                <PasskeyMark />
                {passkeyBusy ? "Waiting for your passkey…" : "Sign in with a passkey"}
              </Button>
            ) : null}
            {googleAvailable ? <GoogleButton purpose="sign_in" extra={{ next }} label="Sign in with Google" onError={setError} /> : null}
            {passkeyProblem ? <p className={styles.note}>{passkeyProblem}</p> : null}
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
