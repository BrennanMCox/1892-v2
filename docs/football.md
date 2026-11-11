# Football Reservations

Keeps the Google Sheet **1892 Football Weekend Reservations** (tab **Requests**) up to date from email to **secretary@1892club.com**, the way it has been kept by hand, replies to each member who sends a new or changed request with a short, fixed acknowledgement, and emails the Chef's covers report on the Wednesday morning before each football weekend. It runs in the background in n8n. The acknowledgement is the only email it ever sends a member.

## What it does

```
Every 15 minutes (at :08, :23, :38 and :53), while a football weekend is open;
every 5 minutes (at :01, :06, ... :56) on its game days, Wednesday to Saturday
 └─> list the last 36 hours of secretary@ mail, Inbox and Sent Items
 └─> skip anything already tagged "Reservations: ...", automated mail (no-reply,
     newsletters, OpenTable and other system senders, out-of-office replies),
     Inbox mail the Secretary Inbox workflow is still working on, Inbox mail
     younger than settleMinutes (20, or 5 on game days), and its own sent Chef
     reports and acknowledgements
 └─> load the CRM (Members tab) once
 └─> one message at a time, oldest first, at most 15 per check, none started
     after 2 minutes (the rest wait for the next check):
       read its thread and the Requests tab (fresh)
       Claude says how the sheet should change (new row, change, cancel,
       update in place, or not football)
       the workflow checks that answer against the sheet's rules, reads the
       tab again, numbers new requests, tags the email "Reservations: Needs
       Review", then writes columns A-W in one batch
       if the write added a row (a new or changed request): reply to the
       member with the acknowledgement (see below), tagging the email
       "Reservations: Acknowledging" first
       tag the email "Reservations: Logged" (or "Reservations: Not Football"),
       replacing that "Needs Review" tag (and "Acknowledging" with
       "Reservations: Acknowledged" once the reply is sent)
 └─> anything that fails for a message: tag it "Reservations: Needs Review",
     write nothing for it, and carry on with the next one
```

The "Needs Review" tag goes on before a write and comes off after it, so if a run is cut off, or Outlook refuses the final tag, the email is left for a person rather than being read and written twice. If you see a "Needs Review" email whose rows are already in the sheet, that is what happened: check the rows and retag the email "Reservations: Logged".

### The acknowledgement

Right after the sheet write, the person who wrote gets this reply, in the same thread (subject "Re: ..."). The reply is this text and nothing else: their email and the earlier thread are **not** quoted below it. (It is still created as an Outlook reply to their email, so it threads with it; the workflow then replaces the draft's whole body, quote included, with the text.)

> Thank you, Ann,
>
> This request has been added to the queue. A member of our team will confirm shortly.
>
> If you need an immediate answer, please call the Club at +1 (762) 402-7833.
>
> Sincerely,
> /claude

**When.** Only when all of these hold:

- the write added at least one row: a new request or a change (`new_row` or `change_row`). A cancellation, a follow-up that only updates Club Reply So Far / Needs a Check, a not-football email, or an email with nothing to change gets no reply;
- the sheet write went through;
- the email is in the Inbox (an email whose folder the workflow cannot tell gets no reply), from someone outside the Club: never a Club message from Sent Items, never from secretary@ itself, a staff domain (`staffDomains`) or an automated sender (From or Reply-To);
- the email is not already tagged "Reservations: Acknowledged" or "Reservations: Acknowledging";
- `acknowledgement.enabled` is `true`.

**To whom.** Exactly one address: the email's Reply-To if it has one, otherwise From. Never Cc, Bcc or reply-all. An email with more than one Reply-To address gets no reply. Before sending, the workflow checks the saved draft goes to that one address and nobody else.

**The name.** From the CRM: the member's First Name (column D) when the address is a member's Email (J), the Spouse's First Name (M) when it is a Spouse's Email (N); if that cell is blank, the first word of the Display Name (B or L), unless it is a title such as "Mr." or "Dr.". Otherwise the first name the sender signed with, as Claude read it, if it is only letters, spaces, hyphens and apostrophes (at most 30). If there is no usable name the reply starts "Thank you,". Claude never writes the reply: the text is the fixed template in `acknowledgement`.

**The tags.** The email is tagged "Reservations: Acknowledging" before the reply is created, and that tag is swapped for "Reservations: Acknowledged" after it is sent. An email with "Acknowledging" but not "Acknowledged" (a run cut off mid-send) is never acknowledged again automatically: check Sent Items and Drafts. If any acknowledgement step fails, the email ends "Reservations: Logged" (the sheet write stands and is never repeated) plus "Reservations: Needs Review": send the acknowledgement by hand, or check that it went, and remove "Needs Review". This includes a reply that is owed but could not be sent safely (Outlook would not say what tags the email has, or the address is not usable). If Outlook also refuses to say what tags the email has at that point, the workflow leaves the tags as they are rather than risk dropping one: the email keeps "Needs Review" (put on before the write) without "Logged"; check the rows are in the sheet, send the acknowledgement, and retag it "Reservations: Logged". A failed attempt may leave a reply draft in Drafts.

A member's email can only change, cancel or update that member's own rows (their email, or their spouse's when the CRM matches them by email). A Club reply from Sent Items only updates Club Reply So Far / Needs a Check, or logs a request the Club passes on. Anything else goes to "Needs Review".

A weekend is **open** until the end of its Saturday (Eastern). When no weekend is open, a check does nothing at all.

### How fast

| Days (Eastern) | Checks | Settle | An email gets its row and acknowledgement |
|---|---|---|---|
| **Game days**: the Wednesday, Thursday, Friday and Saturday of each football weekend in `weekends` (Friday minus 2 to Saturday) | every 5 minutes, at :01, :06, :11 ... :56 (trigger "Game Days") | 5 minutes | usually 6 to 12 minutes after it arrives (see the exceptions below) |
| Every other day while a weekend is open | every 15 minutes, at :08, :23, :38, :53 (trigger "Every 15 Minutes") | 20 minutes | 20 to about 37 minutes after it arrives |

The arithmetic on a game day: an email is read by the first check at which it is at least 5 minutes old (`gameDays.settleMinutes`), so it is read 5 to 10 minutes after it arrives (one that lands at 10:00:59 is 4 minutes 59 seconds old at the 10:06 check and waits for 10:11). Handling one message (thread, sheet, Claude, write, acknowledgement) usually takes about 1 minute. So:

- best case: 5 (settle) + 0 (a check starts right then) + about 1 = **6 minutes**;
- usual worst case: 5 (settle) + up to 5 (waiting for the next slot) + about 1 to 2 (handling) = **11 to 12 minutes**.

**When it takes longer than 12 minutes:**

- **A slow check.** The Claude call alone may take up to 2 minutes, and a check may run until n8n stops it at 270 seconds, so even a lone email can take about 12½ minutes, and at most about 14½ (10 minutes until it is read, plus 4½ minutes of run).
- **Others ahead of it.** One check handles at most 15 emails (`maxPerRun`), oldest first, including the Club's own replies from Sent Items (which have no settle), and starts no new email after 2 minutes (`runBudgetMinutes`); the rest go to the next check, 5 minutes later. So after a burst, or behind a Club reply, an email can take longer than 12 minutes.
- **The Secretary Inbox workflow.** Emails it is visibly working on (`secretaryInProgressCategories`: "Secretary: Working", "Secretary: Run ...", "Secretary: Retrying") wait, on game days too. The Secretary checks every 12 minutes in business hours (hourly overnight) and its run takes a few minutes, so an email it is still working on at Football's check waits at least 5 more minutes. One tagged "Secretary: Retrying", or left "Working" by a Secretary run that crashed (a later Secretary run takes it over once it is 8 minutes old, `stuckAfterMinutes`), waits until the Secretary's next check: up to 12 minutes more in business hours, up to an hour overnight. Because game days settle for 5 minutes rather than 20, the Secretary may also not have tagged an email yet when this one reads it.

The 5-minute trigger's dates are written into it at build time, from `weekends` (one schedule line per weekend, two when its Wednesday to Saturday crosses the end of a month), so adding a weekend and pushing is enough. Both triggers start the same steps; the first step (Config) works out whether today, in Eastern time, is a game day. On a game day a 15-minute check stops at once and only the 5-minute checks read mail; on other days the 5-minute trigger does not fire (and if it ever did, it would stop at once). A schedule line has no year, so a past weekend's line fires again on the same dates the next year; Config stops those runs because they are not game days. The Wednesday 7 a.m. Chef report is unaffected.

**No overlap.** What guarantees that a check never runs into the next one is n8n's own time limit: n8n stops any run after 270 seconds (`executionTimeoutSeconds`), and the build refuses a limit that is not under the shortest check interval (5 minutes on game days). The other settings make that stop rare rather than prove it never happens: a check starts no new email after 2 minutes, the Claude call for the email in hand is limited to 120 seconds and is not retried (a failure tags the email "Needs Review"), and each other call is limited to 30 seconds, but most of those are retried (up to 3 tries), so a slow Outlook or Sheets can still run a check up to the stop. A run cut off mid-write has already tagged the email "Needs Review", so it is never written twice; one cut off before that simply leaves the email for the next check. When n8n stops a run it runs no further steps; depending on the n8n version a request already sent may still finish in the background, which is safe for the same reason (the only write that matters, Write Sheet, comes after the "Needs Review" tag and is not retried).

### The sheet

The workflow writes **only columns A to W** of **Requests**. Columns X to AD (Booked in OpenTable, OpenTable Time, Follow-up Required, Follow-up Done, Secretary Notes, Processed By, Processed On) belong to the Secretary and are never written. The **Chef Summary** tab is never written either; its formulas keep working from A to W.

Changes are kept as an audit log, never overwritten:

| The email | What happens in the sheet |
|---|---|
| A new request | A new row: next Request ID for that weekend (MIZ-072 after MIZ-071), Status Active, the Version formula in W. |
| A change to a request | A **new row** carrying every unchanged value forward, so the Version formula marks the old row Superseded. If the change moves it to another email, experience or fare, the old row is also set to Cancelled and its Needs a Check says "Replaced by MIZ-0xx". |
| A cancellation | The row's Status becomes Cancelled, with a dated note in Needs a Check. No new row. |
| A Club reply (Sent Items) or a follow-up that changes nothing | Club Reply So Far and/or Needs a Check on the current row only. |
| Not about Friday Supper, Brunch or Saturday Supper on an open weekend | Nothing; the email is tagged "Reservations: Not Football". |
| Claude can't tell which row it belongs to | A new row, with the reason in Needs a Check. |

Values that must come from a list (Member Category, Accompanied, Experience, Fare, Arrival Window, Preference) are checked; anything else is left blank and explained in **Needs a Check**. Covers, times and fares are never guessed. Rows with something in **Needs a Check** are the ones a person should look at.

The rules Claude follows (Gown and Town, spouses, phone numbers, mapping times to arrival windows, mixed-fare parties, and so on) are in `n8n/prompts/football-system.md`.

### The Chef report

Every Wednesday at 7 a.m. (Eastern), if a weekend's Friday is two days later, it reads the sheet and creates an email to the Chef (`chefReport.to`, copying `chefReport.cc`) titled "**Requested Covers, Missouri Weekend**", with a link to the sheet and a note that the requests are neither confirmed nor in OpenTable: members and covers for Friday Supper, Brunch and Saturday Supper (Full Fare, Light Fare, Fare Unclear), the dietary restrictions, the requests still missing an experience, covers or a Saturday fare (and what each must confirm), and the requests made after midnight on the deadline. Signed "Sincerely, /claude". It counts only Active rows at their latest version.

It is sent from secretary@ straight away (`"mode": "send"`); set `"mode": "draft"` to leave it in Drafts for someone to check first.

## Set up (once)

In n8n, in the **Claude Code** project (the same place as the other credentials), create:

1. **`1892 Google Sheets`**: type *Google Sheets OAuth2 API*. Sign in with the Google account that **owns both spreadsheets** (the reservations sheet and the CRM), so it can read the CRM and write the Requests tab.
2. **`1892 Anthropic`**: type *Anthropic*. Paste a Claude API key from console.anthropic.com. (Skip this if it already exists for the Secretary Inbox.)
3. The **`1892 Secretary Outlook`** credential already exists; the workflow reads and tags secretary@ mail with it.

Then **pin their ids** in `n8n/deploy.json` (`credentials.googleSheetsOAuth2Api.id` and `credentials.anthropicApi.id`): open each credential in n8n and copy the id from the address bar (`…/credentials/<id>`). This n8n can't list credentials through its API, so the deploy can't look them up by name. Push.

`n8n/deploy.json` already has `"football-reservations": { "active": true }`. The deploy only turns the workflow on once every node has its credential; until then the log says which are missing and it stays off.

## Settings (`n8n/config/football.json`)

| Setting | What it does |
|---|---|
| `mailboxPath`, `mailboxAddress` | The mailbox to read (`me` = the Outlook credential's own mailbox) and its address. |
| `spreadsheetId`, `requestsSheet` | The reservations spreadsheet and its tab. |
| `crm` | The CRM spreadsheet, tab and range. Only the members who match a message (by email, spouse email or surname) are shown to Claude, never the whole CRM. |
| `processReceivedAfter` | Mail received before this (the last manual update) is already in the sheet and is ignored. |
| `lookbackHours` | How far back each check looks. Untagged mail older than this is not read. |
| `maxPerRun`, `runBudgetMinutes` | At most this many messages per check, and no new message is started after this many minutes (2); the rest wait for the next check. |
| `executionTimeoutSeconds` | n8n stops a run after this many seconds (270). The build checks it stays under the shortest check interval (5 minutes on game days) and leaves room after `runBudgetMinutes` for one last message (120 s for Claude plus about 30 s for the other calls when they answer normally). This limit, not the budget, is what keeps runs from overlapping. |
| `settleMinutes`, `secretaryInProgressCategories` | Inbox mail younger than `settleMinutes` (20; 5 on game days, see `gameDays`), or that the Secretary Inbox workflow is still working on, waits for a later check, so the two workflows rarely overwrite each other's tags. |
| `automatedSenders` | Sender patterns that are never read (no-reply, newsletters, OpenTable and similar). |
| `timezone`, `schedule` | Eastern time; check every `everyMinutes` starting `atMinute` past the hour (every 15 minutes from :08). |
| `gameDays` | On game days (Wednesday to Saturday of each weekend): check every `pollMinutes` (5, must divide an hour) starting `atMinute` past the hour (:01; must not share a minute with `schedule`), and settle for `settleMinutes` (5). See "How fast". |
| `model`, `effort`, `maxTokens` | The Claude model and how hard it thinks. |
| `staffDomains` | Senders at these domains (and their subdomains) never get an acknowledgement. |
| `categories` | The Outlook categories it sets. |
| `acknowledgement` | The reply to a new or changed request: `enabled`, the `greeting` (`{name}` is the first name) and `greetingNoName`, the `paragraphs` (`{phone}` is `phone`) and the `signoff` lines. |
| `weekends` | The football weekends (see below). |
| `chefReport` | The Chef report (see below). |

## Add a football weekend

Add an entry to `weekends` in `n8n/config/football.json` and push:

```json
{ "name": "Florida", "prefix": "UF", "friday": "2027-10-29", "saturday": "2027-10-30", "deadline": "2027-10-27T04:00:00Z" }
```

- `name` is what goes in Game Weekend (column C), and what the Chef Summary tab looks for.
- `prefix` starts its Request IDs (UF-001, UF-002, ...).
- `friday` and `saturday` also set its game days, Wednesday to Saturday, when mail is checked every 5 minutes (see "How fast").
- `deadline` is the end of the Tuesday before, as a UTC time: midnight Eastern is `05:00:00Z` in winter (EST) and `04:00:00Z` in summer and early autumn (EDT). It sets By Tuesday Deadline (column T).

The build checks that `friday` is a Friday and `saturday` a Saturday. Past weekends can stay in the list; they are simply closed.

## Send the Chef report automatically

Set `"mode": "send"` in `chefReport` and push. The report is then created and sent at once. `"mode": "draft"` leaves it in Drafts. `"enabled": false` turns it off; `to`, `cc` and `hour` change who gets it and when.

## Good to know

- **Outlook categories.** It applies them by name; they don't need to exist first. To color them, create "Reservations: Logged", "Reservations: Not Football", "Reservations: Needs Review", "Reservations: Acknowledging" and "Reservations: Acknowledged" in Outlook.
- **To re-read an email**, remove its "Logged", "Not Football" or "Needs Review" category (while it's still within `lookbackHours`). Leave "Acknowledged" / "Acknowledging" on it if the member should not get a second acknowledgement.
- **To stop the acknowledgements**, set `"enabled": false` in `acknowledgement` and push.
- **Privacy.** n8n keeps no record of successful runs (they contain member email). Failed runs are kept for debugging.
- **Costs.** One Claude call per real message, Inbox or Sent Items. An acknowledgement adds about six Outlook calls. 96 checks a day while a weekend is open; on game days 288 five-minute checks, plus the 96 fifteen-minute runs that stop at once at Config without calling Outlook (384 runs in all). A check with nothing new makes two Outlook calls and stops.
