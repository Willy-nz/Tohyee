import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { optionalAddress } from "@/lib/email/addresses";
import { readSendingAccount, recordTestResult } from "@/lib/email/settings";
import { createAccountTransport, explainSmtpError, newMessageId, sendMessage } from "@/lib/email/smtp";
import { getOrganisationSettings } from "@/lib/organisations/settings";

/**
 * Sends a test email from the organisation's account (admins), to `to` or
 * the signed-in admin, and records the result. The account is read in one
 * transaction, the email sent with none open, and the result saved in another.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisationRunner(request, body.organisationId, "admin", async (run) => {
    const { account, organisationName, me, organisationId } = await run(async (tx) => ({
      account: await readSendingAccount(tx),
      organisationName: (await getOrganisationSettings(tx)).displayName,
      me: tx.actor.email,
      organisationId: tx.organisationId,
    }));
    const to = optionalAddress(body.to, "The test address") ?? me;
    let error: string | null = null;
    const transport = createAccountTransport(account);
    try {
      await sendMessage(transport, account, {
        to: [to],
        cc: [],
        subject: `Test email from Tohyee for ${organisationName}`,
        text: `This is a test email from Tohyee.\n\nIt was sent from ${account.fromAddress} through ${account.host}, so ${organisationName}'s invoices, quotes, credit notes, purchase orders and statements can be emailed from this account. Replies go to ${account.replyTo ?? account.fromAddress}.`,
        attachment: null,
        messageId: newMessageId(account, organisationId, `test${Date.now()}`),
      });
    } catch (caught) {
      error = explainSmtpError(caught, account).message;
    } finally {
      transport.close();
    }
    const settings = await run((tx) => recordTestResult(tx, { ok: error === null, error, to }));
    return { ok: error === null, error, to, settings };
  });
  return json(result);
});
