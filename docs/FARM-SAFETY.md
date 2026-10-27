# Farm health and safety records

Issue #446 (Jess, 26-27 October 2026), with William's follow-up review and
Jess's "records that stand up if WorkSafe looks at them". Decisions 930-959.

**Tohyee keeps safety records. It doesn't decide what the law needs, and it
doesn't say a farm complies.** The wording below that touches the law is
marked *not yet reviewed by Jess* and listed under
[Open questions](#open-questions-for-jess). Before relying on these records,
have someone who knows health and safety law (WorkSafe, or a lawyer) check
what needs keeping and for how long.

## What WorkSafe's guidance says (read 27 October 2026)

What Tohyee draws on, and where. Several of WorkSafe's farm pages say they
were written before the Health and Safety at Work Act 2015 or haven't been
reviewed since 2017, so they're a guide, not the law.

| Topic | What the guidance says | Source |
|---|---|---|
| Notifiable events | A death, a notifiable injury or illness (for example needing admission to hospital for immediate treatment, an amputation, a serious head, eye or spinal injury, a serious burn or laceration, loss of a bodily function), or a notifiable incident (an unplanned or uncontrolled incident that seriously endangers someone through immediate or imminent exposure, for example a spill or leak, fire or explosion, electric shock, a fall from height, collapse). Notify "as soon as possible after becoming aware". For a death, phone 0800 030 040 straight away; in an emergency, 111. | WorkSafe quick guide *What events need to be notified?* (March 2024); *Notify WorkSafe* page |
| Keeping the site | Don't disturb the site until an inspector says so, except to help someone injured, remove someone who has died, make it safe, or as police or an inspector direct. | *What events need to be notified?* |
| Records of notifiable events | Keep a record of each notifiable event for at least five years from when WorkSafe was told. | *What events need to be notified?*; *Notifiable events for adventure activities* |
| Hazard register | "The most basic document every farm needs is a hazard register", which can be "just a book, spreadsheet or other document"; a farm map showing hazards, no-go zones and safe routes is good practice. | *Managing health and safety: a guide for farmers* (not updated for the 2015 Act) |
| Accident register | Record accidents and serious harm in an accident register. | Same guide |
| Training | An induction covering hazards and safety procedures; keep training records and which jobs each person can and can't do; new workers supervised until they can work safely. | Same guide |
| Contractors | Farmer and contractor work together on overlapping duties; a pre-start talk; tell them about the risks (a marked-up farm map helps), farm rules and emergency procedures; agree check-in and check-out; a backup plan where there's no phone coverage. | *Contractors on farms* fact sheet (October 2016) |
| Hazardous substances | Any quantity means an inventory: each substance's name and UN number, the most likely to be on site, where it is, storage rules, a current safety data sheet (or its key points), any hazardous waste. Readily accessible to emergency services. Safety data sheets more than five years old should be replaced; staff must find them easily and quickly. | *Inventory* page (2017); *Working safely with chemicals and fuels on farms* (2017) |
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

Safety › Records that stand up › WorkSafe pack: everything entered or dated in
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
- `README.txt`: what's there and what it can and can't prove.

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
  emergency), otherwise Notify WorkSafe online; leave the site as it is
  except to help someone, make it safe, or as police or an inspector say.
  **Tohyee never notifies WorkSafe** (or anyone) itself; the report shows
  "May need notifying" until someone records **Record telling WorkSafe**
  (date, phone or online, WorkSafe's reference).
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

## Not done yet

Inductions and sign-offs, sign in on site, pre-start checks, training,
chemicals, the weekly copy emailed off the farm, and the farm workspace
(#447) links follow as further changes on #446. Not in reports yet: telling
staff by email or notification when something is reported (no message is
sent, and nothing claims one was), people involved besides the injured
person, and photos kept in drafts while offline.

## Open questions for Jess

Wording or rules that touch the law, *not yet reviewed by Jess*:

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
