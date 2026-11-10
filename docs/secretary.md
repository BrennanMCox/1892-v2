# Secretary Inbox

The goal: every real person who writes to **secretary@1892club.com** gets a reply within 15 minutes, any hour of the day.

## What it does

```
New mail (checked every minute) ─┐
Safety sweep (every 10 minutes) ─┴─> list the last 24h of Inbox mail
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
- The reply carries the Office of the Secretary sign-off and has no links, images or scripts.

Claude may only state facts written in `n8n/knowledge/club.md`. If a reply would need anything else (hours, prices, rooms, policies), the email is held. So **the more facts Joel adds to that file, the more emails get answered fully and automatically.**

### When something goes wrong

- **Claude is down or declines:** a polite holding reply still goes out, and the email is held for Joel.
- **A run fails halfway:** the email stays tagged "Working". After 6 minutes (`stuckAfterMinutes`) the next run picks it up again. If a reply already went out in that thread, it only tags the email, so nobody gets two replies.
- **The 15 minutes:** new mail starts a run within about a minute. The 10-minute sweep catches anything a failed run missed.

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
| `maxPerRun` | At most this many emails per run; the rest wait for the next run. |
| `stuckAfterMinutes` | Take over an email still tagged "Working" after this long. Keep it above 5 (the run time limit). |
| `sweepMinutes` | How often the safety sweep runs. |
| `model`, `effort`, `maxTokens` | The Claude model and how hard it thinks. |
| `autoSendMinConfidence`, `autoSendCategories` | When a reply may go out unreviewed (see above). |
| `staffDomains`, `alwaysHoldSenders` | Senders that are always held for Joel. |
| `notifyOnHold` | Addresses to email a short notice whenever something is held. Empty means none. |
| `categories` | The Outlook category names it uses. |

The wording, voice and rules Claude follows are in `n8n/prompts/secretary-system.md`.

## Costs to know about

- **n8n executions.** The new-mail trigger only starts a run when mail arrives. The safety sweep starts about 144 runs a day at 10 minutes (about 4,300 a month). On an n8n Cloud plan with an execution cap, raise `sweepMinutes` (for example to 30) if needed.
- **Claude.** One Claude call per real email. Machine-sent mail is filtered out before Claude sees it.

## Outlook categories

The workflow applies its categories by name; they don't need to exist first. To give them colors, create them once in Outlook (**Categorize → Manage categories**) with the names in `categories`.
