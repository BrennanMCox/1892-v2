# Secretary Inbox

The goal: every real person who writes to **secretary@1892club.com** gets a reply within 15 minutes, any hour of the day.

## What it does

```
Every minute ─> list the last 6 hours of Inbox mail
   └─> skip anything already handled, or automated (newsletters, receipts,
       out-of-office replies, bounces, meeting invites, our own mail)
   └─> tag the email "Secretary: Working"
   └─> Claude reads it (plus earlier messages in the thread and the club facts)
       and returns: category, send / hold / ignore, a reply, a holding reply
   └─> hard safety rules decide what actually happens:
         SEND    the reply goes out now, and the email is tagged "Secretary: Replied"
         HOLD    a short holding reply goes out now. Claude's full draft waits in
                 Drafts for Joel. The email is flagged and tagged "Secretary: Needs Joel"
         IGNORE  no reply; tagged "Secretary: No Reply Needed"
```

Joel's to-do list is the flagged emails, plus the drafts that start with a red "Secretary draft for Joel" line.

### What it may send by itself

A reply goes out with no person reading it only if **all** of these hold. Otherwise the email is held.

- Claude chose `send`, with confidence of at least 0.85 (`autoSendMinConfidence`).
- The category is on the `autoSendCategories` list: general questions, dining questions, booking requests (only to gather missing details, never to confirm), and thank-yous.
- Claude listed no missing facts and no risks (money, booking changes, membership, complaints, legal, press, safety, anything sensitive, unclear or suspicious).
- The sender isn't Club staff (`staffDomains`) or on `alwaysHoldSenders`.
- The reply carries the Office of the Secretary sign-off and is plain paragraphs: no links, web addresses, images, styling or other HTML.

The holding reply goes out unread too, so it gets the same HTML checks. If Claude flagged any risk, or its holding reply fails a check, the workflow sends a fixed, plain holding reply instead. Mail from Club staff (`staffDomains`) and `alwaysHoldSenders` gets no holding reply at all; it's just flagged for Joel. A website-form email (one with a Reply-To address) is answered to the Reply-To person only, never reply-all.

Claude may only state facts written in `n8n/knowledge/club.md`. If a reply would need anything else (hours, prices, rooms, policies), the email is held. So **the more facts Joel adds to that file, the more emails get answered fully and automatically.**

### When something goes wrong

- **Claude has a passing error** (overloaded, timeout): the email is tagged "Secretary: Retrying" and the next run, a minute later, tries once more. If that fails too, the fixed holding reply goes out and the email is held for Joel.
- **Claude declines or returns something unusable:** the fixed holding reply goes out and the email is held for Joel.
- **Creating, saving or sending a reply fails:** that email is flagged and tagged "Secretary: Needs Joel". The other emails in the run carry on.
- **A run dies part way:** the email stays tagged "Working". After 8 minutes (`stuckAfterMinutes`) a later run takes it over. If it finds a reply already went out, or can't read the thread to check, it doesn't reply again; it flags the email for Joel. If the second attempt dies too, the email is flagged for Joel without another try.
- **The 15 minutes:** a new email is picked up within a minute and normally answered within two or three. Only one run starts per minute, so two runs never pick up the same email.

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
| `maxPerRun` | At most this many emails go to Claude per run; the rest wait a minute. Automated mail doesn't count. |
| `stuckAfterMinutes` | Take over an email still tagged "Working" after this long. Keep it above 7 (the run time limit). |
| `pollMinutes` | How often it checks the Inbox. 1 meets the 15-minute goal comfortably. |
| `model`, `effort`, `maxTokens` | The Claude model and how hard it thinks. |
| `autoSendMinConfidence`, `autoSendCategories` | When a reply may go out unreviewed (see above). |
| `staffDomains`, `alwaysHoldSenders` | Senders that are always held for Joel. |
| `notifyOnHold` | Addresses to email a short notice whenever something is held. Empty means none. |
| `categories` | The Outlook category names it uses. |

The wording, voice and rules Claude follows are in `n8n/prompts/secretary-system.md`.

## Costs to know about

- **n8n executions.** Checking every minute is about 1,440 runs a day (about 43,000 a month), most of which find nothing. That's fine on a self-hosted n8n. On an n8n Cloud plan with an execution cap, check the cap first. `pollMinutes` of 5 still meets the 15-minute goal at about 8,600 runs a month.
- **Claude.** One Claude call per real email. Machine-sent mail is filtered out before Claude sees it.

## Outlook categories

The workflow applies its categories by name; they don't need to exist first. To give them colors, create them once in Outlook (**Categorize → Manage categories**) with the names in `categories`.
