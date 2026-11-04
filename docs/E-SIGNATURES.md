# E-signatures

How Tohyee's signing works (decisions 1396-1410), and a short, neutral
note on New Zealand law. **This is general information, not legal advice.**
If you're unsure whether a document can be signed electronically, ask a
lawyer.

## What Tohyee does

- **The document is fixed.** A signing request keeps the exact PDF bytes
  people are shown and their SHA-256 (the fingerprint), worked out by the
  database. It can't change after it's sent: a new version is a new
  request.
- **Each signer is identified.** They get a one-time link by email, then
  prove they can read that mailbox with a 6-digit code before they can open
  the document or sign. A member of the organisation can sign in Tohyee
  instead, where their sign-in is the check.
- **Each signer shows they approve.** They must open the document, tick "I
  agree to sign electronically", and type their name or draw a signature.
  Declining needs a reason.
- **What's recorded.** The time (the server's clock), IP address, browser,
  method, the fingerprint of the document they were shown, and how their
  identity was checked.
- **The signed copy.** When everyone has signed, Tohyee keeps a copy with a
  stamp on each page, a signature page and an audit certificate. Files and
  the signing history can't be changed or deleted, by Tohyee or straight in
  the database (triggers refuse it).
- **Checking later.** "Check a copy" re-hashes a file and says whether it's
  unchanged since signing.

What it doesn't do: witnessed signing, digital certificates (PKI or
"advanced" signatures), identity checks beyond email (no ID documents), or
signing on paper.

## New Zealand law (general information, not legal advice)

Part 4 of the Contract and Commercial Law Act 2017 (CCLA, "Electronic
transactions", which replaced the Electronic Transactions Act 2002) is the
main law. In short:

- **When a law needs a signature** (section 226), an electronic signature
  can meet it if it adequately identifies the signer and adequately shows
  they approve the information, and is as reliable as is appropriate for
  the purpose and circumstances. Where the signature relates to information
  that must legally be given to someone, that person must consent to an
  electronic signature.
- **Reliability is presumed** (section 228) when the way of signing is linked
  to the signer and no one else, was under their control and no one else's,
  any change to the signature after signing can be detected, and (where the
  signature is to vouch for the information) any change to the information
  can be detected. Reliability can still be shown, or disputed, in other
  ways.
- **Witnessing** (section 227) can be electronic when the signature
  witnessed is an electronic signature that meets section 226 and the
  witness's electronic signature identifies them, shows they witnessed it
  and is reliable enough. **Tohyee doesn't do witnessed signing**: a
  document that must be witnessed needs to be signed another way.
- **Some documents are left out** (section 218 and Schedule 5). Sources
  summarising Schedule 5 list, among others: wills, codicils and other
  testamentary documents; powers of attorney and enduring powers of
  attorney; affidavits, statutory declarations and other documents given on
  oath or affirmation; and some notices that must be given in writing.
  Section 218(2)(a) also leaves out laws that require a particular
  technology, storage device or kind of communication. Deeds have their own
  signing and witnessing rules.
- **Other bodies may set their own rules.** For example, LINZ says a pasted
  image of a signature, or one drawn on a touch screen, is unlikely to meet
  the reliability criteria for its authority and identity forms. Inland
  Revenue publishes its own standard for electronic signatures on documents
  given to it.

What this means for Tohyee: quotes, employment agreements, inductions and
most business documents are the kind of thing electronic signatures are
commonly used for. For financial statements, check what your entity's
rules and your accountant require (for example who must sign, and whether
anything must be witnessed). Don't use Tohyee for wills, powers of attorney,
affidavits, statutory declarations, deeds that need a witness, or anything
else that must be witnessed.

### Where this came from, and what wasn't checked

legislation.govt.nz couldn't be opened from the sandbox this was written in
(every request to it failed), so the act wasn't read there. What was read:

- Section 227 and section 218, as reproduced on NZLII
  (nzlii.org, consol_act/cacla2017238/s227.html and s218.html).
- The former Electronic Transactions Act 2002 section 24 on NZLII, which
  section 228 carries over (the CCLA's notes say so); section 228's text
  itself wasn't read.
- Section 226 was **not** read directly: its summary above is from LINZ's
  guidance ("Electronic signatures for A&I forms and other documents") and
  section 227's wording, which refers to it.
- Schedule 5's NZLII page showed only its title ("Enactments and provisions
  excluded from subpart 3 of Part 4"); the list of exclusions above is from
  a law firm's summary (Duncan Cotterill, "Electronic signatures: when can I
  use them and when can't I?") and **wasn't checked against the act**.
- The Contract and Commercial Law (Electronic Transactions) Regulations
  2017, on legislation.govt.nz through a summary, which set extra conditions
  for some specific enactments.

Tohyee doesn't claim compliance with any particular law or standard. Before
relying on this note, have it checked against the act on
legislation.govt.nz.
