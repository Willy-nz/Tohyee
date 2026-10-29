# Farm health and safety records

Issue #446 (Jess, 26-27 October 2026), with William's follow-up review and
Jess's "records that stand up if WorkSafe looks at them". Decisions 930-962;
the answers to the open questions are decisions 963-968.

**Tohyee keeps safety records. It doesn't decide what the law needs, and it
doesn't say a farm complies.** The wording that touches the law was listed
under [Open questions](#open-questions-for-jess); those are now answered
(Claude, delegated by Jess, 28 October 2026; not legal advice). Before
relying on these records, have someone who knows health and safety law
(WorkSafe, or a lawyer) check what needs keeping and for how long.

## What WorkSafe's guidance says (read 27 October 2026)

What Tohyee draws on, and where. Several of WorkSafe's farm pages say they
were written before the Health and Safety at Work Act 2015 or haven't been
reviewed since 2017, so they're a guide, not the law.

| Topic | What the guidance says | Source |
|---|---|---|
| Notifiable events | A death, a notifiable injury or illness (for example needing admission to hospital for immediate treatment, an amputation, a serious head, eye or spinal injury, a serious burn or laceration, loss of a bodily function), or a notifiable incident (an unplanned or uncontrolled incident that seriously endangers someone through immediate or imminent exposure, for example a spill or leak, fire or explosion, electric shock, a fall from height, collapse). Notify "as soon as possible after becoming aware". For a death, phone 0800 030 040 straight away; in an emergency, 111. | WorkSafe quick guide *What events need to be notified?* (March 2024); *Notify WorkSafe* page |
| Keeping the site | Don't disturb the site until an inspector says so, except to help someone injured, remove someone who has died, make it safe (or stop another notifiable event), by or as police direct, or with an inspector's permission. | *What events need to be notified?* (Health and Safety at Work Act 2015, s 55) |
| Records of notifiable events | Keep a record of each notifiable event for at least five years from when WorkSafe was told. | *What events need to be notified?*; Health and Safety at Work Act 2015, s 57 |
| Hazard register | "The most basic document every farm needs is a hazard register", which can be "just a book, spreadsheet or other document"; a farm map showing hazards, no-go zones and safe routes is good practice. | *Managing health and safety: a guide for farmers* (not updated for the 2015 Act) |
| Accident register | Record accidents and serious harm in an accident register. | Same guide |
| Training | An induction covering hazards and safety procedures; keep training records and which jobs each person can and can't do; new workers supervised until they can work safely. | Same guide |
| Contractors | Farmer and contractor work together on overlapping duties; a pre-start talk; tell them about the risks (a marked-up farm map helps), farm rules and emergency procedures; agree check-in and check-out; a backup plan where there's no phone coverage. | *Contractors on farms* fact sheet (October 2016) |
| Hazardous substances | Any quantity means an inventory: each substance's name and UN number, the most likely to be on site, where it is, storage rules, a current safety data sheet (or its key points), any hazardous waste. Readily accessible to emergency services. A new safety data sheet is needed when the substance is supplied again after five years, or when its sheet has changed (not "replace sheets older than five years"); staff must find them easily and quickly. | *Inventory* page (2017); *Working safely with chemicals and fuels on farms* (2017); WorkSafe, read 28 October 2026 |
| Paperwork | A good system is practical and used every day; the real test is how well everyone on the farm understands the risks. A record of notifiable incidents is required. | *Health and safety on farms: your questions* (2017) |

## How the records work (decisions 930-934)

- **One list of versions.** Every safety record (a hazard, a farm's emergency
  details, and later reports, checks, sign-offs, training and chemicals) is
  kept as versions in `safety_entries` (tenant migration 0189). A change is a
  new version. A mistake is a **Corrected** version that says what was
  wrong, or the record is **Withdrawn (entered by mistake)** with why; it
  still shows in the history and in the WorkSafe pack.
- **Dated by the database.** Each version's entry time is set by
  PostgreSQL when it's saved, whatever was sent. When it happened (the
  date a hazard was found, an incident's date) is what the person says,
  kept beside it; when that's earlier, both show ("happened 20 Oct, entered
  later").
- **Who entered it** is the signed-in person (never taken from the form),
  and how, when it came through an AI key or farm app.
- **Nothing can be changed, deleted or truncated** in the database: triggers
  refuse it. Photos and documents (`safety_files`) are the same.
- **A hash chain.** The database works out each version's SHA-256 hash from
  its details and the hash of the version before it. Tohyee works the hashes
  out again separately (`src/lib/safety/chain.ts`); **Check the history**
  finds a version whose details were changed straight in the database (past
  the triggers) or one that was removed.
- **What the chain can't show by itself.** Someone with full control of the
  server could rewrite every version after a point and work out new hashes.
  A copy kept off the farm catches that: compare an earlier entry number and
  hash (from a weekly email or a WorkSafe pack) with **Compare with a copy**.
- **Saved twice, kept once.** Each save from a phone carries its own id, so a
  phone sending it again (a poor signal) adds it once.
- **Changed by someone else.** A change names the version it started from;
  if someone saved in between, it's refused with "reload to see their
  change", so nobody's change is lost.

### The WorkSafe pack (decision 934)

Safety › Records and their history › WorkSafe pack: everything entered or dated in
a date range, for one farm or all of the person's farms, each record with
its full history, as a zip:

- `pack.pdf`: the records to read, each version with its entry time, who
  entered it, the date it happened and its hash;
- `entries.json`: those versions exactly as stored;
- `chain.json`: the number and hash of every safety entry in the
  organisation (no details), so the pack's entries can be shown to sit in
  the whole history;
- `files.json` and `files/`: photos and documents the records name, with
  their hashes and dates;
- `verify.mjs`: checks all of it on any computer with Node.js
  (`node verify.mjs`), with no Tohyee needed;
- `README.txt`: what's there and what it can and can't prove, and that
  records of notifiable events must be kept for at least five years from
  when WorkSafe was told (s 57).

A report that may be a notifiable event ends with its keeping period in
`pack.pdf`: "Keep this record until at least {date}" once WorkSafe was told,
otherwise five years from when WorkSafe is told (decision 963).

Restricted details are withheld unless the person may see them: their hash
stays in the chain, so the rest still checks.

## Who sees what (decisions 935-936)

- Safety is part of the farm. Viewers and above read it, on the farms they
  work on (decision 744); a member assigned to one farm can't find another
  farm's records ("not found"), through every route.
- Adding and changing records needs the bookkeeper role or higher for now.
  The field-worker access level from #447 will let farm staff record on
  their farms without the books.
- **Restricted details** (incident and medical details, from the next
  change): owners, members an owner names, and the person who entered them.
  Admins aren't included automatically: an admin is often the accountant.

## Hazards and emergency details (decisions 938-941)

- **Hazards and no-go zones**: what it is, how serious (low, medium, high),
  what's done about it, details, a no-go flag, paddocks, and a place on the
  map (where I am now, a tap on the map, or a drawn zone). Red on the map is
  a no-go zone or a high hazard; amber the rest. **Reviewed: still stands**
  records who looked and when, with the next review date; **Removed from the
  farm** says how. A review past its date shows as overdue.
- **Emergency details**, one record per farm and first on the Safety page:
  111 and WorkSafe's number always, then the farm's address for 111, the
  entrance for emergency services, assembly point, contacts (tap to call),
  first aiders, where the emergency equipment is, the plan where there's no
  phone coverage, the nearest medical centre and notes. **Print** gives a
  paper copy. Each time they load, a copy is kept on the phone, and when
  Tohyee can't be reached that copy shows with the time it was saved.

## Reports, actions and photos (decisions 942-947)

- **Report something** (Safety page, near the top): **Hazard spotted**,
  **Near miss** or **Incident**. A phone-sized form in William's order: a
  photo, what it was, when (date and time; not after today), where (words,
  "where I am now", a paddock), what happened, what was done straight
  away, how bad (minor, moderate, serious), and optionally who'll put it
  right (a member or someone without a login, with a date).
- **Injury details are restricted.** "Someone was hurt or made ill" opens
  who, injury or illness, treatment and an injury photo. They're saved as a
  separate restricted record (decision 936): the farm team sees the report
  and "injury details are restricted"; owners, members an owner names, and
  whoever entered them see the details. Photos follow the same rule.
- **WorkSafe's questions** (incidents and near misses), in WorkSafe's words
  from its quick guide: a death; admitted to hospital as an inpatient; a
  serious injury or illness from WorkSafe's list; someone put in serious,
  immediate danger by something unplanned or out of control. Any yes shows
  a prompt: phone WorkSafe straight away for a death (111 first in an
  emergency), otherwise Notify WorkSafe online; leave the site as it is,
  with WorkSafe's exceptions listed (help someone who's hurt, remove
  someone who has died, make the site safe, the police or as they direct,
  WorkSafe's permission); and keep the record at least five years from when
  WorkSafe is told. A link to **WorkSafe's current guide** sits beside the
  questions so the wording can be checked against it (decision 964).
  **Tohyee never notifies WorkSafe** (or anyone) itself; the report shows
  "May need notifying" until someone records **Record telling WorkSafe**
  (date, phone or online, WorkSafe's reference). Once recorded, the report
  shows "Keep this record until at least {five years after}" (s 57;
  decision 963).
- **Saved on this phone first.** A report is kept in the phone's browser,
  then sent with its own id. With no connection it stays under **Waiting
  to send** ("Saved on this phone, not yet recorded. Nobody has been told
  about these yet."); **Send now** sends each once. A refusal shows **Needs
  attention** with the reason, kept until fixed or discarded. Drafts belong
  to the person and organisation, carry their farm (switching farms never
  moves them), and go after 14 days. Photos need a connection: they're not
  kept in drafts.
- **Photos and documents**: JPEG, PNG, WebP or PDF up to 10 MB, checked to
  be what they say. The database keeps each file's hash and when it
  arrived; the camera's date (from the photo) and the phone's file date
  are kept beside it as given, never as the entry time. The record names
  the file's hash, so it's in the chain too. The WorkSafe pack includes the
  files and `verify.mjs` checks them.
- **Corrective actions** for a report (or a hazard): what needs doing, who
  (a member, or a name), by when. **Mark done** (what was done, a photo),
  then **Check and close** (bookkeeper or above), or **Reopen** (why). An
  action past its date is Overdue. A report can be **Closed** (why) only
  once every action is checked and closed. Marking done, checking,
  reopening and closing are refused through an AI key or farm app: a
  person does them (William: "AI must not independently close an action").
  Open actions per person are ready for Today and the calendar (#447).
- **Owners choose** who else sees injury details, on the Safety page.

## Inductions, sign-offs and signing in on site (decisions 948-952)

- **Inductions** are safety records too (versions). One can be shared by
  every farm; each farm's own active hazards and emergency details always
  show with it, so templates are shared and local details stay local.
  Sections of text, and who it's for (workers, contractors, visitors).
- **Signing.** **Read and sign** shows the induction, the farm's hazards and
  emergency details, then the statement "I have read this induction, the
  farm's hazards and its emergency details, and I'll ask if anything isn't
  clear." A sign-off keeps the induction version, every hazard shown (id and
  version) and the emergency details' version, and how it was signed:
  - on their own login (a worker on their own phone),
  - **recorded for someone** without a login by a bookkeeper or above,
    shown as "recorded for them (not their own signature)", or
  - through the farm's **sign-in link** (name as typed), shown everywhere
    as **self-declared, no login**: in the lists, the WorkSafe pack and
    Today (decision 965). Fine for visitors; the sign-offs list and the
    sign-in link card suggest inviting regular contractors as Farm staff so
    they sign on their own login.
  Every sign-off page says signing shows someone was told; it doesn't show
  they can do a job safely (William: "Do not equate a completed induction
  with demonstrated competence").
- **Sign again.** A sign-off stops being up to date when a new version of
  the induction is saved with "Everyone who signed before must read and
  sign again", or a high or no-go hazard is added or changed after they
  signed. Smaller changes (a low hazard, wording without the tick) don't.
  Who has signed shows **Up to date** or **Sign again**, with the reasons.
- **On site now.** **Sign me in**, or **Sign someone in** (name, company,
  phone, visitor/contractor/worker, what for); **Sign out now**. It's what
  people reported, not where their phone is: the sign-in time shows, and
  someone still signed in from an earlier day says so. A missed sign-out is
  fixed with **They left earlier…**: when they say they left and why, saved
  as a correction (not after now, not before they signed in).
- **The sign-in link** (bookkeeper or above): a QR code and address for the
  gate, optionally until a date, turned off when not wanted (links aren't
  deleted; last used shows). With no Tohyee login, the page shows that
  farm's emergency details (tap to call), hazards and visitor/contractor
  induction, takes name, company, phone, what for and the tick, then signs
  the induction and signs them in. Their phone keeps a one-time sign-out
  token so they can sign out from the same phone. It never shows who else
  is on site, worker-only inductions, or any report; every wrong, expired
  or turned-off link is the same "not found", and it's rate limited. The
  details are kept on the phone and shown with their age when there's no
  signal (signing in then needs a connection). Anyone holding the link can
  read the farm's hazards and emergency details: that's its purpose, and
  why it can be turned off.
- **The gate page's privacy notice** (decision 966), using the
  organisation's name and postal address from its settings: what's
  collected (name, company, phone, what for, sign-in and sign-out times);
  why (health and safety, and emergencies); who sees it (the organisation
  and whoever keeps its safety records; WorkSafe, police or emergency
  services if they need it); company, phone and purpose are optional, and
  someone who won't give their name doesn't sign in there but talks to the
  farm; they can ask to see and correct it (a correction is added, the
  earlier version stays); safety records aren't deleted; and how to contact
  the organisation (its address, or the farm's contacts on the page).

## Equipment, training and chemicals (decisions 953-957)

- **Equipment** on a farm: name, type, whose (ours, hired, a contractor's,
  with a name), a checklist, who's responsible, and who besides owners and
  admins may release it (only an owner or admin, in person, chooses that:
  decision 969). It can name a fixed asset in the books but needn't
  (William: "should not require an accounting fixed asset"). A **QR code**
  for each machine opens its pre-start check after signing in.
- **Checklists** (shared by every farm, or one farm's) are versioned; items
  can be **critical**. A **pre-start check** answers every item OK, Fault
  (saying what's wrong) or Not applicable (never for a critical item), with
  hours or km and a photo, against the version shown. The check copies the
  questions as asked, so changing the checklist never changes an answer.
- **Out of use.** A fault on a critical item puts the machine out of use and
  makes an action for whoever's responsible (or the checker), due today.
  Only an owner, an admin or a member named on it can **release** it, with
  what was done (and a photo), never through an AI key or farm app; the
  database records who and when. Out of use is worked out from the checks
  and releases, not typed in, and the screen says it isn't a physical
  lockout: tag the machine and take the key.
- **Training and qualifications**, for every farm: who (a member or a
  name), what, who gave it, done on (not after today), expires, certificate,
  and the jobs it covers or limits (WorkSafe's farm guide: which jobs each
  person can and can't do), with a certificate photo or PDF. **Expires
  soon** within 60 days, **Expired** after. The person can **confirm it's
  theirs** on their own login (Jess: worker sign-offs on their own phone,
  including training); any later change needs confirming again.
- **Chemicals and fuel**, per farm (WorkSafe's hazardous substances
  inventory): name, UN number, the most likely on site (a decimal, with its
  unit), where it's kept, storage, hazards, whether an approved handler is
  needed, hazardous waste, and the safety data sheet (a PDF) with its date.
  A missing sheet says **Safety data sheet needed**. One over five years
  old, or undated, says **ask for the current one when it's next
  supplied**: WorkSafe's rule is a new sheet when the substance is supplied
  again after five years, or when the sheet has changed, not "replace
  sheets older than five years" (decision 967). **Print** for a paper copy; removed chemicals stay, marked.

## The weekly copy off the farm (decisions 958-959)

Safety › Records and their history › **Weekly copy off the farm** (owners and
admins set it up; tenant migration 0191). Once a week, after 6am, a PDF of
every safety record with an entry since the last copy (each with its
history) is emailed through the organisation's own email account to up to 10 addresses
off the farm (a personal email, the accountant). The email gives the latest
entry's number and hash for the whole history: kept where Tohyee can't
change it, it shows later (**Compare with a copy**) whether the history was
rewritten. Injury and medical details are never in it. **Send a copy now**
sends one straight away. A copy is recorded only when the mail server
accepted it; otherwise the screen shows the last problem and the next
hourly check tries again. Copies sent can't be changed or deleted. What's
in a copy is decided by entry number, not by date (decision 970): every
record with an entry after the last entry number a sent copy included, up
to the newest entry when the copy is made. So a record entered later the
same day as a copy, or while a copy is being sent, is in the next one, and
a failed or retried send loses nothing. The dates in the email are only
for reading.
`TOHYEE_SAFETY_COPY=off` stops the job.

## In the farmer's workspace, and farm staff (decisions 960-962)

- **Safety tab** (#447's Today · Map · Log · Safety · More): the whole
  Safety page for the farm in the farm bar.
- **Map**: hazards and no-go zones over the paddocks (tap one to open
  Safety); a **paddock card** lists that paddock's hazards and has **Report
  a hazard**.
- **Log**: **Report a hazard**, **Near miss** and **Incident** open the same
  report as the Safety page, saved on the phone first.
- **Today**: a Safety card with your open actions, overdue actions and
  actions to check (for those who keep the registers), machines out of use
  or not checked today, inductions to sign (or sign again), training to
  renew and hazard reviews due, the farm's high and no-go hazards, and (for
  those who keep the registers) contractors on site through the sign-in
  link, marked **Self-declared, no login**, with the suggestion to invite
  regular ones as Farm staff.
- **Farm calendar**: **Safety due** for the next 30 days (actions due,
  training expiring, hazard reviews).
- **Farm staff** (#447's role) on their assigned farms only: read Safety;
  report hazards, near misses and incidents (with injury details and
  photos); do pre-start checks; sign inductions and sign in for themselves;
  mark their own actions done; see their own training. They don't keep the
  registers (hazards, equipment, checklists, inductions, training,
  chemicals, sign-in links), check or reopen actions, record for someone
  else, or get the WorkSafe pack or history check. **They never see injury
  or medical details or restricted photos**, not even ones they entered
  or if an owner names them; another farm is "not found".

## Safety on a farm phone (#446 layout follow-up, decisions 976-989)

The Safety tab is a small overview and focused screens, each with its own
address (`/operations/farm/safety?farm=&view=&<record>=`), so links open the
exact record on the right farm and the browser's Back goes back.

- **Overview**: the farm in the farm bar; an **emergency strip** (Call 111,
  the address and entrance, one tap to the full details; the copy on the
  phone, with when it was saved, when Tohyee can't be reached); three large
  buttons, **Report something**, **Check equipment** and **Sign in /
  induction**; **Needs doing** (count, the first five, View all), built
  from Today's data; and **Browse safety** with counts: Hazards and map,
  Equipment and pre-start checks, People and inductions, Reports and
  actions, Chemicals and fuel, and (not farm staff) Records and settings.
  On a desktop, two columns.
- **Focused screens** with **Back to Safety** and the farm's name: emergency
  details; report something; equipment (a search over four machines; one
  machine, its check open, from its QR code or Check); people (On site,
  your inductions with your own status, training; then **For managers**:
  who has signed, adding and changing inductions, the sign-in link); hazards
  (a list first, the map on request); reports and actions (with **Other
  actions**: those on a hazard, from a failed check, or on their own);
  chemicals; records and settings (history check, pack, weekly copy, who
  sees injury details; refused for farm staff as before).
- **Report something**: three large choices, then two short steps: photo,
  what, where (place and paddock), what happened and when; then what was
  done, how bad, injury details and WorkSafe's questions as Yes / No with
  nothing chosen (an unanswered one is kept as not answered, never No) and
  who'll put it right as an optional extra. The half-filled report is kept
  in the browser tab (per person, organisation and farm) while moving
  around Safety and across a reload, and the screen says truthfully
  whether the browser kept it.
- **Pre-start check**: the machine and farm stay at the top; large OK /
  Fault / Not applicable choices, nothing chosen; a fault asks what's wrong
  and offers a photo. Critical faults and release work as before.
- Today's Safety card uses the same list; each line opens its record. Map
  hazards and a paddock card's hazards open the hazard. The old
  `/operations/farming/safety` address (and printed QR codes) redirects.

## Worked examples

Tests cite these IDs (`tests/integration/farm-safety-records.test.ts`,
`tests/unit/safety-chain.test.ts`). Behaviour without an answer from Jess is
"as SafeAg and record-keeping practice suggest, not yet reviewed".

- **FS1 Dated by the database.** Mere adds "Steep creek bank" on 27 October,
  found on 1 September. The version shows entered 27 October (the
  database's time) by Mere, happened 1 September, entered later. An insert
  straight into the table with an entry date of 2020 gets the database's
  time instead, and its own number and chain link.
- **FS2 Versions.** Mere adds "Fenced off; walk the top track". Version 2;
  version 1 is unchanged in the history.
- **FS3 No deletes.** Updating, deleting or truncating the versions or the
  files is refused by the database.
- **FS4 Corrections say why.** Correcting the level from high to medium needs
  "what was wrong"; withdrawing needs why; a withdrawn record can't change
  again and is hidden from the list unless "show withdrawn" is ticked.
- **FS5 Someone else's change isn't lost.** Jess saves from version 2 after
  Mere's version 3: refused, "Someone changed this record (version 3)".
- **FS6 Saved twice, kept once.** The same save id twice gives one version;
  the same id with different details is refused.
- **FS7 Changes behind Tohyee's back show.** With the triggers turned off, the
  first version's title is edited in the database: **Check the history**
  reports that entry's details don't match its hash. An entry deleted the
  same way shows as missing, with the next entry's link broken.
- **FS8 A copy off the farm.** An entry number and hash from an earlier copy
  is "found" when unchanged, "different" when the history before it was
  rewritten (even if the rewritten chain checks out by itself), and
  "missing" when that entry is gone.
- **FS9 Farms kept apart.** Mere, on Home farm only, sees no Runoff hazards,
  can't add one there, can't open one's history, and can't name a Runoff
  paddock on a Home farm hazard.
- **FS10 Restricted details.** Restricted details Mere entered are seen by
  Mere and the owner, not by Aroha (a bookkeeper on all farms) until the owner
  names her, and not after the owner takes it away. Only an owner can name
  someone.
- **FS11 The WorkSafe pack.** For Home farm this year: README, pack.pdf,
  entries.json (every version, including both versions of the effluent pond
  hazard), chain.json, files.json and verify.mjs, which reports "Everything
  in this pack checks out". Editing entries.json makes it report a hash that
  doesn't match. For Mere, who can't see restricted details, they're
  withheld and the rest still checks.
- **FS12 Viewers read.** A viewer sees the Safety page but can't add or
  change a hazard (403).

- **FS13 Injury details kept apart.** Mere reports "Hand caught in the yard
  gate latch" with a photo and injury details (cut to the left hand,
  stitches) and a restricted photo. Aroha (bookkeeper, all farms) sees the
  report and its photo, "injury details are restricted", and can't open the
  restricted photo or change the details; Mere and the owner see them. A
  restricted photo can't go on the open report.
- **FS14 WorkSafe's questions.** A near miss answered yes to "put in
  serious, immediate danger" shows the prompt; nothing is sent anywhere.
  Recording telling WorkSafe needs phone or online and a date not after
  today; it's kept as a version (20 October, phone, WS-123).
- **FS15 Photos.** A JPEG whose camera date is 27 October 07:45 keeps
  "2026-10-27 07:45:00" and the phone's file date beside the database's
  arrival time and hash. Text calling itself a JPEG, an SVG, or a photo for
  another farm is refused.
- **FS16 Actions to a checked close.** An action needs who; a non-member is
  refused. Due 1 October, it's Overdue on Mere's list (not Aroha's). The
  report can't close while it's open; it can't be checked before it's
  done; done and checked are refused through an AI key or farm app; after
  Aroha checks it, it can't be changed without reopening; the report then
  closes with why, and takes no more actions.
- **FS17 Sent twice.** The same report sent again from the phone (same id)
  is one report with one set of injury details.
- **FS18 Farms kept apart.** Mere can't list, change or add actions to
  Runoff reports (route 404). A photo is served with its own type and
  `nosniff`.
- **FS19 Waiting to send** (`tests/unit/safety-drafts.test.ts`). A draft
  survives reopening, belongs to one person and organisation, is sent once
  with its id and removed only when recorded; no connection or a busy
  server keeps it; a refusal marks it needs attention with the reason; it
  goes after 14 days; a phone that can't store it says so.
- **FS20 Photos in the pack.** The owner's pack has both photos and
  `verify.mjs` checks them; Aroha's has only the open one and still checks
  out.

- **FS21 Shared induction, local details.** "Farm induction" for every farm
  is read on Home farm with Home farm's two hazards and assembly point; Mere
  (Home farm only) can't open it for the runoff.
- **FS22 Signing on your own login.** Not ticked, or from an older version:
  refused. Mere's sign-off is entered by Mere, version 1, with both hazards
  at version 1 and emergency details version 1, up to date.
- **FS23 Sign again.** A changed low hazard, or a new version without the
  tick: still up to date. A new high hazard: "New since they signed: Bull in
  paddock 9." Version 3 with the tick: "The induction has changed and
  needs signing again." Mere signs version 3: up to date.
- **FS24 Recorded for someone.** Mere records Hemi (Hemi Fencing): recorded,
  entered by Mere. A viewer can sign for themselves but not record for
  someone else.
- **FS25 On site.** Mere and Ana (vet, recorded by Mere) are on site; a
  viewer can't sign Ana out; Mere signs out (version 2), can't twice; Ana's
  missed sign-out can't be in the future, before she signed in, or without
  why, and is saved as a correction. Both show as left today.
- **FS26 The sign-in link.** The address is `/site/{organisation}/{43-letter
  token}` with a QR code. The page shows Home farm's three hazards and the
  induction for contractors and visitors; not the runoff's hazard, the
  incident, injury details, or anyone's name or email. Rawiri (Spray Co)
  signs the induction and signs in through it (entered by "site sign-in
  link"); without the tick it's refused; a wrong sign-out token isn't found;
  he signs out once. A wrong token, another organisation, or the link once
  turned off: not found (404). A link can't end in the past, or be made for
  a farm the member doesn't work on.
- **FS27 Like every safety record.** Visits and sign-offs have versions and
  the history checks out.

- **FS28 Equipment needn't be in the books.** A quad (ours, with a
  checklist, Rangi responsible and able to release) and a hired digger
  (Digger Hire Ltd, no fixed asset). An unknown fixed asset or "stolen" as
  whose is refused; a viewer can't add equipment. Checklist items get keys
  from their words ("brakes-work").
- **FS29 Answers don't change.** After the checklist is changed to version
  2 ("Brakes: front and back work", "Lights work"), the version-1 check
  still shows its four questions as asked.
- **FS30a Choosing who can release.** Mere (a bookkeeper) can't name herself
  or Rangi as able to release, or take Rangi off, when adding, updating or
  correcting equipment; an owner's AI key or a farm app can't either. Mere
  can still rename the tractor (the list stays as it was). The owner adds
  and takes off releasers; Rangi, named, can release (decision 969).
- **FS30 Out of use.** Mere's check with "Back brake doesn't hold" on the
  critical brakes item puts the quad out of use and gives Rangi an action
  due today naming the check. Mere (not named), an AI key and a release
  without what was done are refused; Rangi releases it ("New back brake
  pads, tested on the hill") and it's in use; a second release is refused.
- **FS31 Answer everything.** A missing answer, a critical item marked not
  applicable, a fault with no note, or the wrong checklist version are
  refused; a fault on a non-critical item (fuel low) is a check with faults
  that leaves the quad in use.
- **FS32 Training.** Hemi's expired chemical course, Mere's quad training
  expiring in 30 days, and Rangi's first aid show Expired, Expires soon and
  Current, soonest first; Mere's own list has only hers. Done after today,
  or expiring before it was done, is refused. Only Mere, on her own login,
  confirms hers; a later change needs confirming again.
- **FS33 Chemicals.** "lots", -5, a quantity without a unit and a two-digit
  UN number are refused. Diesel (UN 1202, 1000.50 L kept as 1000.5, a PDF
  sheet from 2024) is fine; glyphosate with a 2018 sheet needs a new one.
  Removing diesel needs why, and it then lists last.
- **FS34 Farms kept apart.** Mere can't list or check the runoff's
  equipment, or list or add its chemicals; the history checks out.

- **FS35 Who sets it up.** A bookkeeper can't; on with no address, or an
  address that isn't one, is refused; the owner sends it to two addresses.
- **FS36 What's in it.** The email names the latest entry's number and hash
  (the same as Check the history), attaches a PDF, says injury details are
  never in it, and doesn't contain them (they're withheld even though the
  owner may see them).
- **FS37 Only accepted mail counts.** A refused connection, or the mail
  server refusing an address, records the problem and no copy; copies
  can't be deleted.
- **FS38 Weekly.** Two days after a copy, nothing is due; a week later
  (after 6am) the next copy has nothing new and the same latest entry.
- **FS38a Nothing missed between copies.** A hazard entered after a copy
  the same day, a failed send, a hazard the next day, and a hazard added
  while a copy is being sent: the next accepted copy has the first two
  (entries after the last copy's number, up to its own), and the one after
  it has the one added while sending. A change to an older record brings
  its whole history. Off, nothing is sent (decision 970).

- **FS39 Staff read their farm.** Hemi (farm staff, Home farm) gets Home
  farm's Safety (canReport, not canRecord, no restricted details); the
  runoff is 404; the pack is 403.
- **FS40 Staff report.** A hazard report on Home farm (201); on the runoff
  404; adding to the hazard register 403.
- **FS41 No injury details.** Hemi reports a cut hand with details and a
  restricted photo; he then sees "injury details are restricted" and can't
  open the photo, even after the owner names him; the owner sees them.
- **FS42 Checks and actions.** Hemi's failed brakes check puts the quad
  out of use and gives him the action; he can't add actions; he marks his
  own done but can't check it, or mark someone else's done.
- **FS43 Inductions and training.** Today says "Not signed yet."; he signs
  for himself, not for someone else; he sees only his own training and
  can't add any.
- **FS44 Today and the calendar.** Today shows the pond (high, no-go), the
  quad out of use, and an action given to him; the calendar's 2099-01-05
  action shows for him, and the runoff is "not found".

- **FS45 Keeping period** (`tests/unit/safety-chain.test.ts`, the pack
  test). WorkSafe told on 20 October 2026: keep until at least 20 October
  2031; told on 29 February 2028: 1 March 2033. Before it's told, the
  prompt says five years from when WorkSafe is told. The prompt lists
  WorkSafe's five exceptions for disturbing the site. The pack's README
  gives the s 57 rule.
- **FS46 Self-declared, no login.** Rawiri's sign-off through the link is
  labelled "self-declared, no login" in the lists and the pack ("Signed"),
  and while he's on site the owner's Today lists him (Spray Co) that way.
- **FS47 Privacy notice.** For "Kōwhai Farms Ltd" at "12 Test Road, RD 1,
  Madeuptown", the notice covers what's collected, why, who sees it, not
  giving details, seeing and correcting them, how long they're kept, and
  contact ("Kōwhai Farms Ltd, 12 Test Road, RD 1, Madeuptown."); with no
  address it points to the farm's contacts on the page. The gate page's
  details include the organisation's name and address.
- **FS48 Safety data sheets.** Diesel (2024 sheet): fine. Glyphosate (no
  sheet): needed. Petrol (a sheet dated 2018): not needed, but "ask for the
  current one when it's next supplied". Exactly five years old is fine; a
  day more, or undated, is the prompt.
- **FS49 Needs doing opens the record** (`tests/unit/safety-screens.test.ts`,
  `tests/integration/farm-safety-screens.test.ts`). With the quad out of
  use, Hemi's overdue "Fence the pond", an induction to sign, his open
  "Fix the yard rail", someone else's overdue job, one to check, expired
  and expiring training, a hazard review and a self-declared visitor, the
  list is in that order and each links to its record on that farm (an
  action on a report opens the report at the action). Actions not on a
  report (on a hazard, a failed check, or on their own) are listed under
  Other actions until checked and closed; another farm's are not, and
  staff get "not found" for another farm.
- **FS50 Addresses.** `?farm=3&equipment=<id>` opens that machine's check;
  an unknown screen or an id that isn't a record id is ignored; a record
  linked for farm 3 isn't looked for on farm 4.
- **FS51 Half-filled reports.** Kept per person, organisation and farm;
  "kept" only when the browser stored it and reads it back; full, blocked
  or missing storage says it isn't kept; a damaged copy reads as nothing.

## Not done yet

Safety drafts still use their own phone store, not #447's (same rules). The weekly copy's sending through
a real mail account wasn't tried: tests use a stand-in for the mail server. Not in equipment yet: hours-based
service reminders and lockout/tagout steps; policies and procedures as
documents. Not in inductions yet: photos of ID, a contractor's own induction of
the farmer, sending an induction by email or text, and signing in for
several people at once. Not in reports yet: telling
staff by email or notification when something is reported (no message is
sent, and nothing claims one was), people involved besides the injured
person, and photos kept in drafts while offline. From the layout follow-up:
the farmer usability test (3-5 farmers or contractors finding emergency
details, reporting a hazard and doing a pre-start without help) hasn't been
done; that's for people, not code. Screens were checked at 390 px (light and
dark), 1280 px and a 195 px width standing in for 200% zoom, not on real
phones or with a screen reader; offline sending itself is unchanged and was
not re-tried.

## Open questions for Jess

**Answered** in [the 28 October 2026 comment on #446](https://github.com/Willy-nz/Tohyee/issues/446#issuecomment-6451823108) (Claude,
delegated by Jess; checked against WorkSafe's and the Privacy
Commissioner's pages; not legal advice). Decisions 963-968:

1. Emergency card: kept (111 first, then WorkSafe 0800 030 040, "as soon as
   possible"), now also "for a death, phone WorkSafe straight away".
2. Low/medium/high with no-go as its own kind: kept.
3. Keeping period: shown (five years from when WorkSafe was told, s 57;
   decision 963).
4. The pack's README sentence: kept.
5. Restricted details owners-only by default: kept.
6. The questions and prompt: kept, with a link to WorkSafe's current guide
   and the site exceptions listed (decision 964).
7. Minor/moderate/serious, with "notifiable" a separate yes/no: kept.
8. The statement and "doesn't show they can do a job safely": kept.
   Gate-link sign-offs are labelled "self-declared, no login", with the
   suggestion to invite regular contractors as Farm staff (decision 965).
9. The gate page has a short privacy notice (decision 966).
10. "Out of use is a record, not a lock": kept. The safety data sheet line
    follows WorkSafe's rule (decision 967).
11. Weekly copy, "Send a copy now" and the wording: kept.
12. Farm staff don't see injury details they entered: kept; the injured
    person can ask the owner for their own record (Privacy Act).

The questions as they were:

1. The notifiable-event wording on the emergency card ("may need to be told
   to WorkSafe as soon as possible", linking to WorkSafe's page) and the
   numbers shown (111; 0800 030 040, 24 hours).
2. "No-go zone" and the low/medium/high scale: WorkSafe's guidance doesn't
   set a scale; is three levels enough?
3. Whether five years from notification is the keeping period to show for
   notifiable-event records (Tohyee keeps everything; nothing is deleted).
4. The pack's README sentence "Tohyee keeps these records; it doesn't decide
   what the law needs you to keep".
5. Owners (not admins) seeing restricted details by default.
6. WorkSafe's notifiable-event questions as worded in Report something
   (from the March 2024 quick guide), and the prompt's three points
   (phone for a death, Notify WorkSafe otherwise, leave the site as it is
   with WorkSafe's exceptions).
7. The minor/moderate/serious scale for reports.
8. The sign-off statement and the "doesn't show they can do a job safely"
   sentence; whether a sign-off through the link (name as typed, no
   identity check) is good enough for contractors.
9. What the gate page tells people about their details ("The farm keeps
   your name, company, phone and the times you sign in and out"): is a
   fuller privacy notice needed (Privacy Act 2020)?
10. "Out of use is a record, not a lock" and the five-year safety data sheet
    line (from WorkSafe's 2017 farm chemicals page).
11. The weekly copy's wording ("Keep this email somewhere Tohyee can't
    change it") and whether a week is the right interval.
