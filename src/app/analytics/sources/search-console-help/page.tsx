import type { Metadata } from "next";
import Link from "next/link";
import { Card, Page, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Adding your website to Google Search Console" };

const code = { wordBreak: "break-all" as const, overflowWrap: "anywhere" as const };
const list = { paddingLeft: 20, display: "grid", gap: 8, margin: 0 };

/**
 * Setup help for the Google Search Console source (#512, decision 1187):
 * adding and verifying a site, the Shopify route (meta tag in the theme or
 * a DNS domain property), submitting the sitemap, and why a new property
 * has no data for a few days. Help only: nothing here is saved.
 */
export default function SearchConsoleHelpPage() {
  return (
    <Page>
      <PageHeader
        title="Adding your website to Google Search Console"
        description="Do this once in Google, then come back and connect Search Console in Data sources."
      />
      <div style={{ display: "grid", gap: 16, maxWidth: 820 }}>
        <Card title="1. Add your website">
          <ol style={list}>
            <li>
              Go to <a href="https://search.google.com/search-console" target="_blank" rel="noreferrer">search.google.com/search-console</a> and sign in with the Google
              account you&apos;ll connect to Tohyee.
            </li>
            <li>
              Choose <strong>Add property</strong>. There are two kinds:
              <ul style={{ paddingLeft: 20, marginTop: 6 }}>
                <li>
                  <strong>Domain</strong> (for example <code>example.co.nz</code>) covers the whole domain: www and not, http and https, every subdomain. It&apos;s the
                  better choice if you can change the domain&apos;s DNS.
                </li>
                <li>
                  <strong>URL prefix</strong> (for example <code>https://www.example.co.nz/</code>) covers only addresses that start exactly like that. Use it when you
                  can&apos;t change DNS.
                </li>
              </ul>
            </li>
          </ol>
        </Card>

        <Card title="2. Prove it's yours">
          <p>
            <strong>Domain property: a DNS record.</strong> Google shows a TXT record starting <code>google-site-verification=</code>. Add it as a TXT record where
            your domain&apos;s DNS is managed, then choose <strong>Verify</strong>. DNS changes can take from a few minutes to a day to show.
          </p>
          <p>
            <strong>URL-prefix property: a meta tag.</strong> Choose the <strong>HTML tag</strong> method. Google shows a line like{" "}
            <code style={code}>&lt;meta name=&quot;google-site-verification&quot; content=&quot;…&quot; /&gt;</code> to put in your home page&apos;s{" "}
            <code>&lt;head&gt;</code>.
          </p>
        </Card>

        <Card title="On Shopify">
          <p>Either way works on Shopify.</p>
          <p>
            <strong>The meta tag in your theme</strong> (a URL-prefix property, e.g. <code>https://www.yourshop.co.nz/</code>):
          </p>
          <ol style={list}>
            <li>In Shopify admin, go to <strong>Online Store › Themes</strong>.</li>
            <li>
              On your current theme, open the <strong>…</strong> menu and choose <strong>Edit code</strong>.
            </li>
            <li>
              Under <strong>Layout</strong>, open <code>theme.liquid</code>.
            </li>
            <li>
              Paste Google&apos;s meta tag on its own line just after <code>&lt;head&gt;</code> (anywhere before <code>&lt;/head&gt;</code> is fine), and choose{" "}
              <strong>Save</strong>.
            </li>
            <li>
              Back in Search Console, choose <strong>Verify</strong>. Keep the tag there: if it&apos;s removed, or you change to another theme without it, Google stops
              treating the site as verified.
            </li>
          </ol>
          <p style={{ marginTop: 12 }}>
            <strong>A domain property through DNS:</strong> if you bought the domain through Shopify, go to <strong>Settings › Domains</strong>, choose the domain, then{" "}
            <strong>Domain settings › Edit DNS settings › Add custom record</strong>, choose <strong>TXT</strong>, and paste Google&apos;s value (name <code>@</code>). If
            the domain is with another company, add the TXT record there instead.
          </p>
          <p>
            Shopify makes your sitemap for you, at <code style={code}>https://your-domain/sitemap.xml</code> (your shop&apos;s main domain). You don&apos;t need to
            create one.
          </p>
        </Card>

        <Card title="3. Submit your sitemap">
          <ol style={list}>
            <li>In Search Console, choose the property, then <strong>Sitemaps</strong> on the left.</li>
            <li>
              Under <strong>Add a new sitemap</strong>, type <code>sitemap.xml</code> (for a domain property, the full address, e.g.{" "}
              <code style={code}>https://www.yourshop.co.nz/sitemap.xml</code>) and choose <strong>Submit</strong>.
            </li>
            <li>The status should show <strong>Success</strong> after a while. It helps Google find every page, but isn&apos;t needed for the search figures.</li>
          </ol>
        </Card>

        <Card title="4. Wait a few days, then connect">
          <p>
            A new property has no figures at first: Google starts counting when the property is added, and its data is 2 to 3 days behind. Expect the first figures
            after a few days. Once the site is verified you can connect it in Tohyee straight away; loads before then just bring in nothing.
          </p>
          <p>
            Google keeps 16 months of search data. Tohyee&apos;s first load goes back that far, then each night it fetches the new days and the last few days again,
            as Google may still change those.
          </p>
          <p>
            Then go to <Link href="/analytics/sources">Data sources</Link> › Add data source › Google Search Console. An admin also needs the Google Search Console API
            turned on in the organisation&apos;s Google app (the steps are on that screen).
          </p>
        </Card>
      </div>
    </Page>
  );
}
