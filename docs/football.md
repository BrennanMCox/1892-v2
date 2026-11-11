# Football Reservations

Keeps the Google Sheet **1892 Football Weekend Reservations** (tab **Requests**) up to date from email to **secretary@1892club.com**, the way it has been kept by hand, and drafts the Chef's covers report on the Wednesday morning before each football weekend. It runs in the background in n8n. **It never emails members.**

## What it does

```
Every 15 minutes (at :08, :23, :38 and :53), while a football weekend is open
 └─> list the last 36 hours of secretary@ mail, Inbox and Sent Items
 └─> skip anything already tagged "Reservations: ...", automated mail (no-reply,
     newsletters, OpenTable and other system senders, out-of-office replies),
     and Inbox mail the Secretary Inbox workflow is still working on
 └─> load the CRM (Members tab) once
 └─> one message at a time, oldest first, at most 15 per check:
       read its thread and the Requests tab (fresh)
       Claude says how the sheet should change (new row, change, cancel,
       update in place, or not football)
       the workflow checks that answer against the sheet's rules, reads the
       tab again, numbers new requests, tags the email "Reservations: Needs
       Review", then writes columns A-W in one batch
       tag the email "Reservations: Logged" (or "Reservations: Not Football"),
       replacing that "Needs Review" tag
 └─> anything that fails for a message: tag it "Reservations: Needs Review",
     write nothing for it, and carry on with the next one
```

The "Needs Review" tag goes on before a write and comes off after it, so if a run is cut off, or Outlook refuses the final tag, the email is left for a person rather than being read and written twice. If you see a "Needs Review" email whose rows are already in the sheet, that is what happened: check the rows and retag the email "Reservations: Logged".

A member's email can only change, cancel or update that member's own rows (their email, or their spouse's when the CRM matches them by email). A Club reply from Sent Items only updates Club Reply So Far / Needs a Check, or logs a request the Club passes on. Anything else goes to "Needs Review".

A weekend is **open** until the end of its Saturday (Eastern). When no weekend is open, a check does nothing at all.

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

Every Wednesday at 7 a.m. (Eastern), if a weekend's Friday is two days later, it reads the sheet and creates an email to the Chef (`chefReport.to`, copying `chefReport.cc`) titled "**Missouri covers for the Chef**": parties and covers for Friday Supper, Brunch and Saturday Supper (Full Fare, Light Fare, fare not given), the dietary restrictions, the requests with no covers or experience, and the requests made after the deadline. It counts only Active rows at their latest version.

By default it is left in secretary@'s **Drafts** for someone to check and send.

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
| `maxPerRun`, `runBudgetMinutes` | At most this many messages per check, and no new message is started after this many minutes; the rest wait for the next check. The run's time limit is `runBudgetMinutes` plus 10 minutes (room for the last message) and must stay under the 15-minute schedule, so `runBudgetMinutes` can be at most 4. |
| `settleMinutes`, `secretaryInProgressCategories` | Inbox mail younger than this, or that the Secretary Inbox workflow is still working on, waits for a later check, so the two workflows never overwrite each other's tags. |
| `automatedSenders` | Sender patterns that are never read (no-reply, newsletters, OpenTable and similar). |
| `timezone`, `schedule` | Eastern time; check every `everyMinutes` starting `atMinute` past the hour. |
| `model`, `effort`, `maxTokens` | The Claude model and how hard it thinks. |
| `categories` | The Outlook categories it sets. |
| `weekends` | The football weekends (see below). |
| `chefReport` | The Chef report (see below). |

## Add a football weekend

Add an entry to `weekends` in `n8n/config/football.json` and push:

```json
{ "name": "Florida", "prefix": "UF", "friday": "2027-10-29", "saturday": "2027-10-30", "deadline": "2027-10-27T04:00:00Z" }
```

- `name` is what goes in Game Weekend (column C), and what the Chef Summary tab looks for.
- `prefix` starts its Request IDs (UF-001, UF-002, ...).
- `deadline` is the end of the Tuesday before, as a UTC time: midnight Eastern is `05:00:00Z` in winter (EST) and `04:00:00Z` in summer and early autumn (EDT). It sets By Tuesday Deadline (column T).

The build checks that `friday` is a Friday and `saturday` a Saturday. Past weekends can stay in the list; they are simply closed.

## Send the Chef report automatically

Set `"mode": "send"` in `chefReport` and push. The report is then created and sent at once. `"mode": "draft"` (the default) leaves it in Drafts. `"enabled": false` turns it off; `to`, `cc` and `hour` change who gets it and when.

## Good to know

- **Outlook categories.** It applies them by name; they don't need to exist first. To color them, create "Reservations: Logged", "Reservations: Not Football" and "Reservations: Needs Review" in Outlook.
- **To re-read an email**, remove its "Reservations: ..." category (while it's still within `lookbackHours`).
- **Privacy.** n8n keeps no record of successful runs (they contain member email). Failed runs are kept for debugging.
- **Costs.** One Claude call per real message, Inbox or Sent Items. 96 checks a day while a weekend is open; a check with nothing new makes two Outlook calls and stops.
