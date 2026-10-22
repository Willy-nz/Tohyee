import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import styles from "@/components/office/office.module.css";

export const metadata: Metadata = { title: "Tohyee Analytics for PowerPoint: help" };

/** The add-in's support page (the manifest's SupportUrl, #429): what it does and where to get help. */
export default function PowerPointHelpPage() {
  return (
    <main className={styles.panelScreen}>
      <section className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={24} />
          <span>Tohyee</span>
        </div>
        <h1 className={styles.title}>Tohyee Analytics for PowerPoint</h1>
        <p>The add-in shows a live Tohyee Analytics report on a slide. Everyone who views the slide signs in to Tohyee and sees only what they can see there. Someone who can&apos;t sign in sees the picture saved the last time someone did.</p>
        <p>To add it to a slide: Insert › Add-ins (Home › Add-ins on the web), choose Tohyee Analytics, sign in, and pick an organisation, a report and a page or tile.</p>
        <p>To stop it signing in on a computer, choose Sign out on the slide, or sign it out under Your account › Connected apps in Tohyee.</p>
        <p>Questions about your Tohyee server go to whoever runs it.</p>
      </section>
    </main>
  );
}
