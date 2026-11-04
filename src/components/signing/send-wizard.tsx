"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChoiceTiles } from "@/components/choice-tiles";
import { InfoTip } from "@/components/info-tip";
import { SetupProgress } from "@/components/store-setup";
import { Button, Field, Notice, ui } from "@/components/ui";
import { errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { isEmailAddress } from "@/lib/email/addresses";
import { DEFAULT_EXPIRY_DAYS, LEGAL_NOTE, MAX_EXPIRY_DAYS, MAX_SIGNING_PDF_BYTES, type SigningOrder, type SigningRequestView } from "@/lib/signing/shared";
import wizard from "../store-setup.module.css";
import styles from "./signing.module.css";

/*
 * Sending a document to sign, one step at a time like the store and bank
 * feed setups (decisions 1250-1259, 1404): document, who signs, message,
 * check, send. Nothing is sent until the last step.
 */

type Step = "document" | "signers" | "message" | "review" | "send";
const STEPS: Step[] = ["document", "signers", "message", "review", "send"];
const STEP_NAMES: Record<Step, string> = { document: "Document", signers: "Who signs", message: "Message", review: "Check", send: "Send" };
const STEP_TITLES: Record<Step, string> = {
  document: "Which document?",
  signers: "Who signs?",
  message: "What should the email say?",
  review: "Check before sending",
  send: "Send it",
};

export type SignerDraft = { name: string; email: string; roleLabel: string };
export type MemberOption = { userId: string; name: string; email: string };
export type UploadedPdf = { fileName: string; contentBase64: string; size: number };

export type SendPayload = {
  idempotencyKey: string;
  signers: SignerDraft[];
  signingOrder: SigningOrder;
  message: string | null;
  expiresInDays: number;
  remindEveryDays: number | null;
  upload: UploadedPdf | null;
  title: string | null;
};

export type SendOutcome = { request: SigningRequestView; emailNote: string | null };

function readFile(file: File): Promise<UploadedPdf> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve({ fileName: file.name, contentBase64: result.slice(result.indexOf(",") + 1), size: file.size });
    };
    reader.onerror = () => reject(new Error("The file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

export function SendForSigning({
  document,
  upload = false,
  initialSigners,
  maxSigners,
  roleLabelName = "Signing as",
  members = [],
  emailReady,
  emailReason,
  remindersOffered = false,
  onSend,
  onDone,
  onCancel,
  extraReview,
}: {
  /** The document to sign, when it's made by Tohyee (a quote, the financial statements). */
  document: { name: string; previewHref: string | null; text: ReactNode } | null;
  /** Choose a PDF to upload instead. */
  upload?: boolean;
  initialSigners: SignerDraft[];
  maxSigners: number;
  roleLabelName?: string;
  members?: MemberOption[];
  emailReady: boolean;
  emailReason: string | null;
  remindersOffered?: boolean;
  onSend: (payload: SendPayload) => Promise<SendOutcome>;
  onDone: (outcome: SendOutcome) => void;
  onCancel: () => void;
  extraReview?: ReactNode;
}) {
  const [step, setStep] = useState<Step>("document");
  const [signers, setSigners] = useState<SignerDraft[]>(initialSigners.length ? initialSigners : [{ name: "", email: "", roleLabel: "" }]);
  const [order, setOrder] = useState<SigningOrder>("in_order");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [days, setDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [remind, setRemind] = useState(remindersOffered ? "3" : "");
  const [file, setFile] = useState<UploadedPdf | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey("signing"));
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);

  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);

  const memberEmails = new Set(members.map((member) => member.email.toLowerCase()));
  const outsiders = signers.filter((signer) => signer.email && !memberEmails.has(signer.email.trim().toLowerCase()));

  const gaps = (at: Step): string[] => {
    if (at === "document") {
      if (upload && !file) return ["Choose the PDF to send."];
      if (upload && !title.trim()) return ["Give it a title, so people know what they're signing."];
      return [];
    }
    if (at === "signers") {
      const list: string[] = [];
      const seen = new Set<string>();
      signers.forEach((signer, index) => {
        if (!signer.name.trim()) list.push(`Add signer ${index + 1}'s name.`);
        if (!isEmailAddress(signer.email.trim())) list.push(`Add signer ${index + 1}'s email address.`);
        const email = signer.email.trim().toLowerCase();
        if (email && seen.has(email)) list.push(`${email} is on the list twice.`);
        seen.add(email);
      });
      if (!emailReady && outsiders.length) list.push(`${emailReason ?? "Email isn't set up."} People without a Tohyee login need email for their link and code.`);
      return list;
    }
    if (at === "message") {
      const value = Number(days);
      if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_DAYS) return [`Links can work for 1 to ${MAX_EXPIRY_DAYS} days.`];
      return [];
    }
    return [];
  };

  const current = gaps(step);
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const at = STEPS.indexOf(step);
  const done = (each: Step) => STEPS.indexOf(each) < at;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await onSend({
        idempotencyKey,
        signers: signers.map((signer) => ({ name: signer.name.trim(), email: signer.email.trim(), roleLabel: signer.roleLabel.trim() })),
        signingOrder: order,
        message: message.trim() || null,
        expiresInDays: Number(days),
        remindEveryDays: remind ? Number(remind) : null,
        upload: file,
        title: title.trim() || null,
      });
      onDone(outcome);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const setSigner = (index: number, change: Partial<SignerDraft>) => setSigners((list) => list.map((signer, at) => (at === index ? { ...signer, ...change } : signer)));
  const move = (index: number, by: number) =>
    setSigners((list) => {
      const next = [...list];
      const [moved] = next.splice(index, 1);
      next.splice(index + by, 0, moved);
      return next;
    });

  let body: ReactNode;
  if (step === "document") {
    body = upload ? (
      <div className={styles.stack}>
        <Field label="PDF">
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={async (event) => {
              const chosen = event.target.files?.[0];
              if (!chosen) return setFile(null);
              if (chosen.size > MAX_SIGNING_PDF_BYTES) {
                setError("A PDF to sign can be at most 25 MB.");
                return setFile(null);
              }
              try {
                const read = await readFile(chosen);
                setFile(read);
                if (!title.trim()) setTitle(chosen.name.replace(/\.pdf$/i, ""));
              } catch (caught) {
                setError(errorMessage(caught));
              }
            }}
          />
        </Field>
        <Field label="Title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="e.g. Lease renewal, 12 George St" />
        </Field>
      </div>
    ) : (
      <div className={styles.stack}>
        <div>{document?.text}</div>
        {document?.previewHref ? (
          <p style={{ margin: 0 }}>
            <a href={document.previewHref} target="_blank" rel="noreferrer">
              Look at {document.name}
            </a>
          </p>
        ) : null}
      </div>
    );
  } else if (step === "signers") {
    body = (
      <div className={styles.stack}>
        <ol className={styles.signerList}>
          {signers.map((signer, index) => (
            <li key={index}>
              <div className={styles.signerRow}>
                <Field label={`Signer ${index + 1}: name`}>
                  <input value={signer.name} onChange={(event) => setSigner(index, { name: event.target.value })} maxLength={150} autoComplete="off" />
                </Field>
                <Field label="Email">
                  <input type="email" value={signer.email} onChange={(event) => setSigner(index, { email: event.target.value })} maxLength={320} autoComplete="off" />
                </Field>
                <Field label={roleLabelName}>
                  <input value={signer.roleLabel} onChange={(event) => setSigner(index, { roleLabel: event.target.value })} maxLength={100} placeholder="Optional" />
                </Field>
                {maxSigners > 1 ? (
                  <div className={styles.actions}>
                    {order === "in_order" && index > 0 ? (
                      <Button variant="secondary" size="small" onClick={() => move(index, -1)} aria-label={`Move signer ${index + 1} up`}>
                        ↑
                      </Button>
                    ) : null}
                    {order === "in_order" && index < signers.length - 1 ? (
                      <Button variant="secondary" size="small" onClick={() => move(index, 1)} aria-label={`Move signer ${index + 1} down`}>
                        ↓
                      </Button>
                    ) : null}
                    {signers.length > 1 ? (
                      <Button variant="secondary" size="small" onClick={() => setSigners((list) => list.filter((_, at) => at !== index))} aria-label={`Remove signer ${index + 1}`}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {memberEmails.has(signer.email.trim().toLowerCase()) ? <p className={styles.muted} style={{ margin: "6px 0 0" }}>Has a Tohyee login: can also sign in Tohyee.</p> : null}
            </li>
          ))}
        </ol>
        {maxSigners > 1 && signers.length < maxSigners ? (
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setSigners((list) => [...list, { name: "", email: "", roleLabel: "" }])}>
              Add someone
            </Button>
            {members.length ? (
              <Field label="Add a member">
                <select
                  value=""
                  onChange={(event) => {
                    const member = members.find((each) => each.userId === event.target.value);
                    if (!member) return;
                    setSigners((list) => {
                      const blank = list.findIndex((each) => !each.name && !each.email);
                      const added = { name: member.name, email: member.email, roleLabel: "" };
                      return blank >= 0 ? list.map((each, at) => (at === blank ? added : each)) : [...list, added];
                    });
                  }}
                >
                  <option value="">Choose…</option>
                  {members
                    .filter((member) => !signers.some((signer) => signer.email.trim().toLowerCase() === member.email.toLowerCase()))
                    .map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.name} ({member.email})
                      </option>
                    ))}
                </select>
              </Field>
            ) : null}
          </div>
        ) : null}
        {maxSigners > 1 && signers.length > 1 ? (
          <ChoiceTiles
            label="Signing order"
            value={order}
            onChange={setOrder}
            options={[
              { value: "in_order", title: "In order", text: "Each person is asked once the one before has signed." },
              { value: "any_order", title: "Any order", text: "Everyone is asked at once." },
            ]}
          />
        ) : null}
      </div>
    );
  } else if (step === "message") {
    body = (
      <div className={styles.stack}>
        <Field label="Message (optional)">
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} maxLength={2000} placeholder="e.g. Here's the quote we talked about. Any questions, just reply." />
        </Field>
        <Field label="Links work for (days)">
          <input type="number" min={1} max={MAX_EXPIRY_DAYS} value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" />
        </Field>
        {remindersOffered ? (
          <Field label="Remind people who haven't signed">
            <select value={remind} onChange={(event) => setRemind(event.target.value)}>
              <option value="">Don&apos;t remind</option>
              <option value="1">Every day</option>
              <option value="3">Every 3 days</option>
              <option value="7">Every week</option>
            </select>
          </Field>
        ) : null}
      </div>
    );
  } else if (step === "review") {
    body = (
      <div className={styles.stack}>
        <dl className={styles.review}>
          <dt>Document</dt>
          <dd>{upload ? `${title} (${file?.fileName ?? ""})` : document?.name}</dd>
          <dt>Who signs</dt>
          <dd>
            {signers.map((signer, index) => (
              <div key={index}>
                {signers.length > 1 && order === "in_order" ? `${index + 1}. ` : ""}
                {signer.name} ({signer.email}){signer.roleLabel ? `, ${signer.roleLabel}` : ""}
              </div>
            ))}
          </dd>
          {signers.length > 1 ? (
            <>
              <dt>Order</dt>
              <dd>{order === "in_order" ? "In order" : "Any order"}</dd>
            </>
          ) : null}
          <dt>Message</dt>
          <dd>{message.trim() || "None"}</dd>
          <dt>Links work for</dt>
          <dd>{days} days</dd>
          {remindersOffered ? (
            <>
              <dt>Reminders</dt>
              <dd>{remind ? `Every ${remind === "1" ? "day" : remind === "7" ? "week" : `${remind} days`}` : "None"}</dd>
            </>
          ) : null}
        </dl>
        {extraReview}
      </div>
    );
  } else {
    body = (
      <div className={styles.stack}>
        <p style={{ margin: 0 }}>
          {emailReady
            ? `Tohyee emails ${signers.length === 1 ? signers[0].name : "each person, when it's their turn,"} a link. They check it's them with an emailed code, read it, and sign.`
            : "Email isn't set up, so nobody is emailed. Members on the list sign in Tohyee (Signing)."}{" "}
          <InfoTip label="About electronic signatures">{LEGAL_NOTE}</InfoTip>
        </p>
        <Notice tone="warning">Once it&apos;s sent, the document can&apos;t be changed. To change it, void the request and send a new one.</Notice>
      </div>
    );
  }

  const next = STEPS[at + 1];
  return (
    <div className={wizard.wizard}>
      <SetupProgress steps={STEPS} names={STEP_NAMES} current={step} done={done} />
      <h3 className={wizard.stepTitle} ref={heading} tabIndex={-1}>
        {STEP_TITLES[step]}
      </h3>
      {body}
      {current.length ? (
        <Notice tone="warning">
          <strong>Before you go on:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {current.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={wizard.footer}>
        <div className={ui.actions}>
          {at > 0 ? (
            <Button variant="secondary" onClick={() => go(STEPS[at - 1])} disabled={busy}>
              Back
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
        <div className={wizard.footerRight}>
          {step === "send" ? (
            <Button onClick={() => void send()} disabled={busy}>
              {busy ? "Sending…" : "Send to sign"}
            </Button>
          ) : (
            <Button onClick={() => go(next)} disabled={current.length > 0}>
              Next: {STEP_NAMES[next].toLowerCase()}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
