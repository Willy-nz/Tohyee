"use client";

import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

type Status = { remoteAddress: string | null; available: boolean; manifestUrl: string | null; contentUrl: string | null };

/**
 * Settings › PowerPoint add-in (admins; #429, decisions 831-832): the add-in's
 * manifest for this server, and plain steps to install it in PowerPoint
 * yourself or for your whole Microsoft 365 organisation. Only while Remote
 * access is on with an https address: PowerPoint needs to reach Tohyee from
 * outside, and loads add-ins only over https.
 */
export default function PowerPointAddinPage() {
  const { can } = useWorkspace();
  const status = useApiData<Status>("/api/powerpoint-addin");
  const data = status.data;
  return (
    <Page>
      <PageHeader title="PowerPoint add-in" description="Live Tohyee Analytics reports on PowerPoint slides, for Windows, Mac and PowerPoint on the web." />
      {!can("admin") ? <Notice tone="info">An admin of this organisation sets up the add-in.</Notice> : null}
      {status.error ? <Notice tone="error">{status.error}</Notice> : null}
      {data && !data.available ? (
        <Notice tone="warning">
          The add-in only works through Remote access, and {data.remoteAddress ? "this server's Remote access address isn't https" : "Remote access is off"}. A server admin can turn it on in the Tohyee server app (Remote
          access). Then this page offers the add-in.
        </Notice>
      ) : null}
      {data?.available && data.manifestUrl ? (
        <>
          <Card title="1. Download the add-in" description="The manifest tells PowerPoint where this Tohyee is. It holds no passwords or keys.">
            <p>
              <a className={`${ui.button} ${ui.primary}`} href={`${data.manifestUrl}?download=1`} download="tohyee-powerpoint-addin.xml">
                Download the manifest
              </a>
            </p>
            <p className={ui.muted}>
              The file is tohyee-powerpoint-addin.xml. Its address, if Microsoft 365 asks for one:{" "}
              <code style={{ wordBreak: "break-all" }}>{data.manifestUrl}</code>
            </p>
          </Card>
          <Card title="2a. Just you: upload it in PowerPoint">
            <ol>
              <li>Open PowerPoint (Windows, Mac or on the web) and a presentation.</li>
              <li>
                Choose <strong>Home › Add-ins</strong> (on Windows and Mac it may be <strong>Insert › Add-ins › Get Add-ins</strong>), then <strong>My Add-ins</strong>.
              </li>
              <li>
                Choose <strong>Upload My Add-in</strong>, pick the file you downloaded and choose <strong>Upload</strong>.
              </li>
              <li>
                <strong>Tohyee Analytics</strong> appears on the slide. Sign in, then pick an organisation, a report and a page or tile.
              </li>
            </ol>
            <p className={ui.muted}>
              On the web an uploaded add-in stays in that browser only. If Upload My Add-in isn&apos;t there, your Microsoft 365 admin has turned it off: use 2b. On some versions
              of PowerPoint for Windows, an add-in from a file has to come from a shared folder catalogue instead (File › Options › Trust Center › Trusted Add-in Catalogs).
            </p>
          </Card>
          <Card title="2b. Everyone in your organisation: deploy it in Microsoft 365">
            <ol>
              <li>
                A Microsoft 365 admin opens the <strong>Microsoft 365 admin center</strong> and goes to <strong>Settings › Integrated apps</strong>.
              </li>
              <li>
                Choose <strong>Upload custom apps</strong>, choose <strong>Office Add-in</strong>, and upload the file (or give the manifest&apos;s address above).
              </li>
              <li>Choose who gets it (everyone, or some people or groups) and finish.</li>
              <li>
                It can take up to a day to show up. People then find <strong>Tohyee Analytics</strong> under <strong>Add-ins › Admin Managed</strong> in PowerPoint.
              </li>
            </ol>
          </Card>
          <Card title="How it works">
            <ul>
              <li>Each person signs in with their own Tohyee sign-in (password and two-step, or Google) and sees only what they can see in Analytics. A report viewer sees only the reports shared with them.</li>
              <li>It only reads Analytics. It can&apos;t change anything in Tohyee.</li>
              <li>
                Someone who can&apos;t sign in (or doesn&apos;t have the add-in) sees a picture saved the last time someone signed in looked at it, so anyone with the file can see that picture.
                Turn it off for a slide when you add the report.
              </li>
              <li>People can see and sign out their add-in sign-ins under Your account › Connected apps.</li>
              <li>If the Remote access address changes, download the manifest again and replace the add-in.</li>
            </ul>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
