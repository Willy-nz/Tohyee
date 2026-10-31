"use client";

import Link from "next/link";
import { Suspense, useSyncExternalStore } from "react";
import { MetaAppForm, MetaCheckSetup } from "@/components/analytics-meta";
import { RequireOrganisation } from "@/components/books";
import { Card, Page, PageHeader } from "@/components/ui";
import { META_ADS_PERMISSION, META_CALLBACK_PATH, META_PERMISSION_TEXT, META_PERMISSIONS } from "@/lib/analytics/meta-reports";

const code = { wordBreak: "break-all" as const, overflowWrap: "anywhere" as const };
const list = { paddingLeft: 20, display: "grid", gap: 8, margin: 0 };

/** The return address to paste into Meta: this server's own address, as the browser sees it. */
function ReturnAddress() {
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
  return <code style={code}>{origin ? `${origin}${META_CALLBACK_PATH}` : META_CALLBACK_PATH}</code>;
}

/**
 * Guided setup for the Meta source (#516, decisions 1191 and 1201): making
 * a Meta app, the products to add, the return address to paste, why
 * development mode is fine for your own accounts, making Instagram a
 * professional account linked to the Page, then saving the app and Check
 * setup. The menu names are Meta's as its developer pages describe them
 * (31 Oct 2026); Meta changes them often.
 */
export default function MetaSetupPage() {
  return (
    <Page>
      <PageHeader
        title="Setting up Meta (Facebook and Instagram)"
        description="Do this once. Then connect Meta in Data sources. Tohyee only ever reads: it can't post, reply or change anything."
      />
      <div style={{ display: "grid", gap: 16, maxWidth: 860 }}>
        <Card title="1. Make a free Meta app">
          <ol style={list}>
            <li>
              Go to <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a> and log in with the Facebook account
              that manages your Page. If it&apos;s your first time, Meta asks you to register as a developer (free; it may ask to confirm a phone number).
            </li>
            <li>
              Choose <strong>Create app</strong>. Give it a name such as &quot;Tohyee reports&quot; and your email.
            </li>
            <li>
              When Meta asks what the app is for, choose <strong>Other</strong>, then the app type <strong>Business</strong>. If it asks for a business portfolio, choose
              yours or skip it; it isn&apos;t needed for your own Page.
            </li>
          </ol>
        </Card>

        <Card title="2. Add the Facebook Login and Instagram products">
          <ol style={list}>
            <li>
              On the app&apos;s dashboard, add <strong>Facebook Login for Business</strong> (choose <strong>Set up</strong>).
            </li>
            <li>
              Add <strong>Instagram</strong> and choose <strong>API setup with Facebook login</strong> (not &quot;with Instagram login&quot;: Tohyee reads Instagram through
              your Page).
            </li>
            <li>
              Only if you want ads too: add <strong>Marketing API</strong>.
            </li>
            <li>
              Recommended: in <strong>Facebook Login for Business › Configurations</strong>, choose <strong>Create configuration</strong>. Call it &quot;Tohyee read
              only&quot;, choose <strong>User access token</strong>, and tick only these permissions:
              <ul style={{ paddingLeft: 20, marginTop: 6 }}>
                {[...META_PERMISSIONS, META_ADS_PERMISSION].map((name) => (
                  <li key={name}>
                    <code>{name}</code>: {META_PERMISSION_TEXT[name]}
                    {name === META_ADS_PERMISSION ? " (only for ads)" : ""}
                  </li>
                ))}
              </ul>
              Copy its <strong>Configuration ID</strong> for step 4. Without a configuration, Tohyee asks for the same permissions itself.
            </li>
          </ol>
        </Card>

        <Card title="3. Add Tohyee's return address">
          <ol style={list}>
            <li>
              Go to <strong>Facebook Login for Business › Settings</strong>.
            </li>
            <li>
              Under <strong>Valid OAuth Redirect URIs</strong>, paste exactly: <ReturnAddress />
            </li>
            <li>
              Leave <strong>Client OAuth login</strong> and <strong>Web OAuth login</strong> on, and choose <strong>Save changes</strong>.
            </li>
          </ol>
        </Card>

        <Card title="4. Copy the app ID and secret into Tohyee">
          <p>
            In <strong>App settings › Basic</strong>, copy the <strong>App ID</strong>, and the <strong>App secret</strong> (choose <strong>Show</strong>; Facebook may ask
            for your password). Paste them here. The secret is stored encrypted and never shown again.
          </p>
          <Suspense fallback={null}>
            <RequireOrganisation>{(organisationId) => <MetaAppForm key={organisationId} organisationId={organisationId} onSaved={() => undefined} />}</RequireOrganisation>
          </Suspense>
        </Card>

        <Card title="Development mode is fine">
          <p>
            Leave the app in <strong>Development</strong> mode. For your own Page, Instagram and ad account, Meta needs no App Review and no business verification: people
            with a role on the app can use it straight away, and you&apos;re its admin because you made it. Meta asks for App Review only for an app used with other
            people&apos;s businesses.
          </p>
          <p>
            For someone else in your business to connect it (for example a bookkeeper), add them in <strong>App roles › Roles</strong> as an Administrator, Developer or
            Tester, and they accept the invitation in their own Meta for Developers account. They also need a role on the Page.
          </p>
        </Card>

        <Card title="Instagram: a professional account linked to the Page">
          <div id="instagram" />
          <p>Meta only gives figures for Instagram business or creator accounts that are linked to a Facebook Page. A personal account can&apos;t be read.</p>
          <ol style={list}>
            <li>
              In the Instagram app, go to your profile, then <strong>Menu › Account type and tools › Switch to professional account</strong>, and choose{" "}
              <strong>Business</strong> (or Creator). It&apos;s free and can be switched back.
            </li>
            <li>
              Link it to the Page: in <strong>Meta Business Suite › Settings › Instagram accounts</strong>, choose <strong>Connect account</strong>; or on Facebook, open
              the Page, then <strong>Settings › Linked accounts › Instagram</strong>.
            </li>
            <li>
              When you connect Meta in Tohyee, tick the Page (and the Instagram account, if Meta asks) on the screen where Meta asks what Tohyee can use.
            </li>
            <li>Follows and unfollows by day need 100 followers or more; Meta leaves them out below that.</li>
          </ol>
        </Card>

        <Card title="5. Check setup, then connect">
          <p>
            Check setup asks Meta about each part (the app and its secret, the sign-in and permissions, the Page, Instagram and ads) and says plainly what to fix. It
            changes nothing.
          </p>
          <Suspense fallback={null}>
            <RequireOrganisation>{(organisationId) => <MetaCheckSetup key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
          </Suspense>
          <p style={{ marginTop: 12 }}>
            Then go to <Link href="/analytics/sources">Data sources</Link> › Add data source › Meta (Facebook and Instagram) and choose <strong>Connect Meta</strong>.
          </p>
          <p>
            How long the sign-in lasts: Meta gives Tohyee a sign-in of about 60 days, and a Page access that doesn&apos;t end on a date. The Page and Instagram keep
            loading after 60 days; ads, and choosing another Page, need you to connect again (one button). Changing your Facebook password or removing the app ends the sign-in, and Meta can also
            end access after 90 days without using the app; Tohyee says so and asks you to connect again.
          </p>
        </Card>
      </div>
    </Page>
  );
}
