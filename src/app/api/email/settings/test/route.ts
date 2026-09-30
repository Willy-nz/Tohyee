import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { optionalAddress } from "@/lib/email/addresses";
import { renderEmailHtml } from "@/lib/email/html";
import { saveRefreshedTokens } from "@/lib/email/microsoft";
import { explainOpenError, openSender } from "@/lib/email/sender";
import { readSendingAccount, recordTestResult } from "@/lib/email/settings";
import { newMessageId } from "@/lib/email/smtp";
import { formatGstNumber } from "@/lib/format";
import { emailLogo, getLogo } from "@/lib/organisations/logo";
import { getOrganisationSettings } from "@/lib/organisations/settings";

/**
 * Sends a test email from the organisation's account (admins), to `to` or
 * the signed-in admin, and records the result: through SMTP or the
 * connected Microsoft mailbox, as HTML with the logo and as plain text. The
 * account is read in one transaction, the email sent with none open, and the
 * result saved in another.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisationRunner(request, body.organisationId, "admin", async (run) => {
    const { account, settings, logo, me, organisationId } = await run(async (tx) => ({
      account: await readSendingAccount(tx),
      settings: await getOrganisationSettings(tx),
      logo: await getLogo(tx),
      me: tx.actor.email,
      organisationId: tx.organisationId,
    }));
    const organisationName = settings.displayName;
    const to = optionalAddress(body.to, "The test address") ?? me;
    const through = account.method === "microsoft" ? `the Microsoft mailbox ${account.fromAddress}` : `${account.fromAddress} through ${account.host}`;
    const text = `This is a test email from Tohyee.\n\nIt was sent from ${through}, so ${organisationName}'s invoices, quotes, credit notes, purchase orders and statements can be emailed from this account. Replies go to ${account.replyTo ?? account.fromAddress}.`;
    const image = emailLogo(logo);
    const subject = `Test email from Tohyee for ${organisationName}`;
    let error: string | null = null;
    let sender: Awaited<ReturnType<typeof openSender>> | null = null;
    try {
      sender = await openSender(account, (tokens) => run((tx) => saveRefreshedTokens(tx, account.fromAddress, tokens)));
    } catch (caught) {
      error = explainOpenError(account, caught).message;
    }
    if (sender) {
      try {
        await sender.send({
          to: [to],
          cc: [],
          subject,
          text,
          html: renderEmailHtml({
            subject,
            body: text,
            organisation: {
              name: organisationName,
              postalAddress: settings.postalAddress,
              gstNumber: settings.gstNumber ? formatGstNumber(settings.gstNumber) : null,
              email: account.replyTo ?? account.fromAddress,
            },
            summary: [],
            logo: image?.html ?? null,
          }),
          attachment: null,
          inline: image ? [image.inline] : [],
          messageId: newMessageId(account, organisationId, `test${Date.now()}`),
        });
      } catch (caught) {
        error = sender.explain(caught).message;
      } finally {
        sender.close();
      }
    }
    const saved = await run((tx) => recordTestResult(tx, { ok: error === null, error, to }));
    return { ok: error === null, error, to, settings: saved };
  });
  return json(result);
});
