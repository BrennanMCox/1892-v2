# Secretary Inbox

The goal: every real person who writes to **secretary@1892club.com** gets a reply

- within **18 minutes** from 7 a.m. to 7 p.m. (Eastern time), and
- within **75 minutes** overnight, from 7 p.m. to 7 a.m.

To do that, it checks the Inbox every 12 minutes from 7 a.m. to 7 p.m. and every hour on the hour overnight. A check takes a few minutes at most, so the slowest normal case is an email that arrives just after a check: 12 minutes of waiting plus the work, inside 18 (or 60 plus the work, inside 75).

## What it does

```
Each check ─> list the last 6 hours of Inbox mail
   └─> skip anything already handled, or automated (newsletters, receipts,
       out-of-office replies, bounces, meeting invites, our own mail)
   └─> tag the email "Secretary: Working"
   └─> Claude reads it (plus earlier messages in the thread and the club facts)
       and returns: category, send / hold / ignore, a reply, a holding reply
   └─> hard safety rules decide what actually happens:
         SEND    the reply goes out now, and the email is tagged "Secretary: Replied"
         HOLD    a short holding reply goes out now. Claude's full draft waits in
                 Drafts for review. The email is flagged and tagged "Secretary: Needs Review"
         IGNORE  no reply; tagged "Secretary: No Reply Needed"
```

The Club team's to-do list is the flagged emails, plus the drafts that start with a red "Secretary draft for review" line.

### What it may send by itself

A reply goes out with no person reading it only if **all** of these hold. Otherwise the email is held.

- Claude chose `send`, with confidence of at least 0.85 (`autoSendMinConfidence`).
- The category is on the `autoSendCategories` list: general questions, dining questions, booking requests (only to gather missing details, never to confirm), and thank-yous.
- Claude listed no missing facts and no risks (money, booking changes, membership, complaints, legal, press, safety, anything sensitive, unclear or suspicious).
- The sender isn't Club staff (`staffDomains`) or on `alwaysHoldSenders`.
- The reply carries the Office of the Secretary sign-off and is plain paragraphs: no links, web addresses, images, styling or other HTML.

The holding reply goes out unread too, so it gets the same HTML checks. If Claude flagged any risk, or its holding reply fails a check, the workflow sends a fixed, plain holding reply instead. Mail from Club staff (`staffDomains`) and `alwaysHoldSenders` gets no holding reply at all; it's just flagged for review. A website-form email (one with a Reply-To address) is answered to the Reply-To person only, never reply-all.

Claude may only state facts written in `n8n/knowledge/club.md`. If a reply would need anything else (hours, prices, rooms, policies), the email is held. So **the more facts you add to that file, the more emails get answered fully and automatically.**

### When something goes wrong

- **Claude has a passing error** (overloaded, timeout): if the next check is early enough to still meet the reply goal, the email is tagged "Secretary: Retrying" and that check tries once more. With checks every 12 minutes and an 18-minute goal, that's usually too late, so the fixed holding reply goes out right away and the email is held for review.
- **Claude declines or returns something unusable:** the fixed holding reply goes out and the email is held for review.
- **Creating, saving or sending a reply fails:** that email is flagged and tagged "Secretary: Needs Review". The other emails in the run carry on.
- **A run dies part way:** the email stays tagged "Working". After 8 minutes (`stuckAfterMinutes`) a later run takes it over. If it finds a reply already went out, or can't read the thread to check, it doesn't reply again; it flags the email for review. If the second attempt dies too, the email is flagged for review without another try.
- **A run dies part way, and the reply goal:** recovery happens at the first check at least 8 minutes later, so an email caught in a crashed run can miss its goal by one check. That needs Microsoft 365 or n8n to fail mid-run, and the email is flagged for review either way.
- **Two runs at once:** checks are minutes apart, and each run tags the emails it claims. If runs ever overlap (a slow Microsoft 365 or a queued n8n), each one checks its claim again just before replying, and only the run that still holds it goes ahead.

## Going live, safely

1. **Shadow mode (the default).** `"mode": "shadow"` in `n8n/config/secretary.json`. The workflow does everything except send. Each email gets a draft reply that starts with a red line saying what it *would* have done, and is tagged "Secretary: Shadow Draft". Run it like this for a few days and read the drafts.
2. **Set the start date.** `processReceivedAfter` stops it answering old mail. Set it to the moment you go live (e.g. `"2026-11-12T14:00:00Z"`).
3. **Turn it on.** Set `"mode": "live"` in `n8n/config/secretary.json` and `"active": true` for `secretary-inbox` in `n8n/deploy.json`. Push.

## Settings (`n8n/config/secretary.json`)

| Setting | What it does |
|---|---|
| `mode` | `shadow`: draft only, send nothing. `live`: send. |
| `mailboxPath` | `me` when the n8n Outlook credential signs in as secretary@ (recommended). For a shared mailbox, use `users/secretary@1892club.com`; the signed-in user then needs full access and Send As on it. |
| `mailboxAddress` | The mailbox's own address, so it never answers itself. |
| `processReceivedAfter` | Ignore mail received before this time (ISO 8601, UTC). |
| `maxAgeHours` | Never answer mail older than this. |
| `maxPerRun` | At most this many emails go to Claude per check; any more wait for the next check. Automated mail doesn't count. |
| `stuckAfterMinutes` | Take over an email still tagged "Working" after this long. Keep it above 7 (the run time limit). |
| `schedule.timezone` | The time zone for the hours below. |
| `schedule.businessHours` | `startHour` to `endHour` (24-hour clock; 7 to 19 means 7 a.m. to 7 p.m.), checking every `pollMinutes`, with a goal of `replyWithinMinutes`. |
| `schedule.afterHours` | The rest of the day: `pollMinutes` (60 means on the hour) and `replyWithinMinutes`. |
| `model`, `effort`, `maxTokens` | The Claude model and how hard it thinks. |
| `autoSendMinConfidence`, `autoSendCategories` | When a reply may go out unreviewed (see above). |
| `staffDomains`, `alwaysHoldSenders` | Senders that are always held for review, with no auto-reply: Club and Thoreau Capital addresses, and the former Secretary's address. |
| `notifyOnHold` | Addresses to email a short notice whenever something is held. Empty means none. |
| `categories` | The Outlook category names it uses. |

`pollMinutes` must divide an hour evenly (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) or be 60. The build refuses a schedule whose `pollMinutes`, plus about 5 minutes of work, doesn't fit inside its `replyWithinMinutes`.

The wording, voice and rules Claude follows are in `n8n/prompts/secretary-system.md`.

## Costs to know about

- **n8n executions.** 60 checks between 7 a.m. and 7 p.m. plus 12 overnight is 72 runs a day, about 2,200 a month.
- **Claude.** One Claude call per real email. Machine-sent mail is filtered out before Claude sees it.

## Outlook categories

The workflow applies its categories by name; they don't need to exist first. To give them colors, create them once in Outlook (**Categorize → Manage categories**) with the names in `categories`.
