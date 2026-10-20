import { type AiTool, schema } from "@/lib/ai/tools";
import type { AiTokenIdentity } from "@/lib/ai/tokens";
import { mailOwnerForKey } from "@/lib/private-mail/ai";
import { readMyThread, searchMyMail } from "@/lib/private-mail/store";
import type { MailPerson } from "@/lib/private-mail/types";

/*
 * The AI's tools for its Owner's private mail (#250 part 2; PM17, PM18,
 * decision 618). Offered only to a Look only key its Owner gave the
 * private-mail scope (src/lib/private-mail/ai.ts); each call goes through
 * the same owner-only access layer as My mail. Each answer says which
 * email it came from, so the AI can cite it.
 */

const MAX_TEXT = 20_000;

function who(person: MailPerson | null): string {
  if (!person) return "(no sender)";
  return person.name ? `${person.name} <${person.email}>` : person.email;
}

function cite(input: { id: string; subject: string | null; from: MailPerson | null; sentAt: string }): string {
  return `Email "${input.subject || "(no subject)"}" from ${who(input.from)}, ${input.sentAt.slice(0, 10)} (My mail message ${input.id})`;
}

export function privateMailTools(identity: Pick<AiTokenIdentity, "tokenId" | "accessLevel">): AiTool[] {
  return [
    {
      name: "search_my_mail",
      title: "Search my mail",
      description:
        "Searches the private copy of your own email (My mail): only you, its Owner, can use this. Whole words; every word must be in the email; from:address and to:address match people. Without a query, the newest emails. Returns up to 50, newest first, each with a citation; pass `before` from the answer for more. Never repeat what you find to anyone else or put it into Tohyee.",
      inputSchema: schema({
        query: { type: "string", description: "Words to find, e.g. 'soil test paddock 12' or 'from:results@lab.example'." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        before: { type: "string", description: "The `more` value from the last answer, for the next page." },
      }),
      level: "read",
      async run(tx, args) {
        const owner = await mailOwnerForKey(tx, identity);
        const found = await searchMyMail(tx, owner, { query: args.query, limit: args.limit, before: args.before });
        return {
          emails: found.hits.map((hit) => ({ messageId: hit.id, sentAt: hit.sentAt, from: who(hit.from), subject: hit.subject, snippet: hit.snippet, attachments: hit.attachmentCount, deletedInMailbox: hit.deletedInMailbox, cite: cite(hit) })),
          more: found.more,
        };
      },
    },
    {
      name: "read_my_mail",
      title: "Read an email from my mail",
      description:
        "Reads one email's conversation from the private copy of your own email (My mail), oldest first, with each email's text, people and attachment names, and a citation for each. Only you, its Owner, can use this. Say which email you used when you answer; never repeat it to anyone else or put it into Tohyee.",
      inputSchema: schema({ messageId: { type: "string", description: "A messageId from search_my_mail." } }, ["messageId"]),
      level: "read",
      async run(tx, args) {
        const owner = await mailOwnerForKey(tx, identity);
        const thread = await readMyThread(tx, owner, args.messageId);
        return {
          mailbox: thread.mailbox,
          emails: thread.messages.map((message) => ({
            messageId: message.id,
            sentAt: message.sentAt,
            from: who(message.from),
            to: message.to.map(who),
            cc: message.cc.map(who),
            subject: message.subject,
            text: message.text.length > MAX_TEXT ? `${message.text.slice(0, MAX_TEXT)}… (cut short)` : message.text,
            attachments: message.attachments.map((file) => ({ name: file.name, size: file.size, kept: file.kept })),
            link: message.webLink,
            deletedInMailbox: message.deletedInMailbox,
            cite: cite(message),
          })),
        };
      },
    },
  ];
}
