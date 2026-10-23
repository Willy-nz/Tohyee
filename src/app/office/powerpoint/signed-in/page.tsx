"use client";

import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import styles from "@/components/office/office.module.css";
import { officeReady, OFFICE_JS_URL } from "@/lib/office/client/office-js";

/**
 * Where the PowerPoint add-in's sign-in window ends (#429, decision 842):
 * Tohyee sends the browser here with the one-time code after the person
 * allows the add-in, and this page hands the code (and the state the slide
 * sent) back to the slide with Office's messageParent, then the window
 * closes. The code is taken out of the address straight away. Opened
 * outside Office, it does nothing with the code.
 */
export default function SignedInPage() {
  const [message, setMessage] = useState("Finishing signing in…");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const answer = { type: "tohyee-sign-in", code: query.get("code"), state: query.get("state"), error: query.get("error") };
    window.history.replaceState(null, "", window.location.pathname);
    let cancelled = false;
    void officeReady().then((found) => {
      if (cancelled) return;
      if (!found) {
        setMessage("Signing in finished. This window belongs to PowerPoint: you can close it.");
        return;
      }
      const text = JSON.stringify(answer);
      try {
        // Only to the slide's own address (DialogApi 1.2); older Office takes the message without the option.
        try {
          found.office.context.ui.messageParent(text, { targetOrigin: window.location.origin });
        } catch {
          found.office.context.ui.messageParent(text);
        }
        setMessage("Signed in. You can close this window if it stays open.");
      } catch {
        setMessage("PowerPoint didn't take the sign-in. Close this window and try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main className={styles.panelScreen}>
      <script src={OFFICE_JS_URL} async />
      <section className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={24} />
          <span>Tohyee</span>
        </div>
        <p role="status">{message}</p>
      </section>
    </main>
  );
}
