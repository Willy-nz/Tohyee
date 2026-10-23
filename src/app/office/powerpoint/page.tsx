import type { Metadata } from "next";
import { headers } from "next/headers";
import { BrandMark } from "@/components/brand-mark";
import { PowerPointAddin } from "@/components/office/powerpoint-addin";
import styles from "@/components/office/office.module.css";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor } from "@/lib/office/addin";
import { OFFICE_JS_URL } from "@/lib/office/client/office-js";

// Reads the remote access setting and the request's address on every visit.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Tohyee Analytics for PowerPoint" };

/**
 * The PowerPoint add-in's slide page (#429, decisions 831, 838): what Office
 * shows in the add-in's box on a slide. The only Tohyee page Office may
 * frame (src/lib/office/csp.ts), and only on the remote access (https)
 * address: anywhere else it says so and shows nothing.
 */
export default async function PowerPointSlidePage() {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  const host = (await headers()).get("host");
  if (!addresses || !host || host.toLowerCase() !== new URL(addresses.origin).host.toLowerCase()) {
    return (
      <main className={styles.panelScreen}>
        <section className={styles.panel}>
          <div className={styles.brand}>
            <BrandMark size={24} />
            <span>Tohyee</span>
          </div>
          <h1 className={styles.title}>Only through Remote access</h1>
          <p>
            {addresses
              ? `The PowerPoint add-in only works at ${addresses.origin}. Install it from the manifest in Tohyee's Settings › PowerPoint add-in.`
              : "The PowerPoint add-in only works through Tohyee's Remote access (https) address, and Remote access is off. A server admin can turn it on in the Tohyee server app."}
          </p>
        </section>
      </main>
    );
  }
  return (
    <>
      {/* Office.js from Microsoft's CDN, as Microsoft requires; React puts it in the page's head. */}
      <script src={OFFICE_JS_URL} async />
      <PowerPointAddin origin={addresses.origin} />
    </>
  );
}
