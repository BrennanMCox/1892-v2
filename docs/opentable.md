# OpenTable Replies

Answers member emails to **secretary@1892club.com** that ask the Club to book a table for **six or fewer**, within about 15 minutes, with a fixed note pointing them to OpenTable. The note is **sent at once** (no draft), and only to the member who wrote. It is deliberately cautious: **when in doubt, it does not reply**, and a person answers as usual.

Claude only reads the email and describes it (is it a new table request, for how many people, for which dates). Claude never writes the reply: its text is fixed, below.

## What it does

```
Every 15 minutes (at :03, :18, :33 and :48)
 └─> list the last 24 hours of secretary@ Inbox mail (never Sent Items or Drafts)
 └─> skip, untouched: mail already tagged "OpenTable: ...", mail under 5 minutes
     old, mail the Secretary Inbox workflow is working on (these wait)
 └─> load the CRM (Members tab) once
 └─> one message at a time, oldest first, at most 15 per check:
       staff, automated or from secretary@ itself?  -> "OpenTable: No Reply"
       not a member (by email)?                     -> "OpenTable: No Reply"
       the Club already replied, or this conversation
       already had an OpenTable reply?              -> "OpenTable: No Reply"
       Claude describes the email; the rules below decide
       not a clear table request for 1-6, or a football date?
                                                    -> "OpenTable: No Reply"
       otherwise: tag "OpenTable: Sending", reply to the member only, send,
       then swap the tag for "OpenTable: Replied"
 └─> anything that fails for a message: tag it "OpenTable: Needs Review" and
     carry on with the next one
```

## When it replies

Every one of these must hold. Otherwise the email is tagged **OpenTable: No Reply** and nothing else happens.

1. **A member's own email in the Inbox.** Not a draft, not from secretary@ itself, not from a staff domain (`staffDomains`: 1892club.com, thoreaucapital.com, theindigoroad.com, in From or Reply-To), not automated (no-reply and system senders such as OpenTable, newsletters and mailing lists, out-of-office replies, bounces, meeting invitations and responses), and not already tagged with one of the four "OpenTable: ..." categories. Drafts and already-tagged mail are left untouched; staff, automated and secretary@ mail is tagged "OpenTable: No Reply".
2. **The sender is in the CRM.** The address the reply would go to (the email's Reply-To if it has one, otherwise From) is a member's **Email** (column J) or a **Spouse's Email** (column N), ignoring case. Non-members never get a reply. An email with more than one Reply-To address gets no reply.
3. **A new table request for 1 to 6 people, not on a football weekend.** Claude says it is a new request to book a dining table (not a change, cancellation or follow-up, not a question about menus, hours or policies, not a private event, room booking, large group or catering, not on someone else's behalf), and gives the party size only when stated or unambiguous ("my wife and I" = 2). Then the code checks:
   - the party size is a whole number from 1 to `maxPartySize` (6). Unknown size: no reply;
   - no requested date is a football Friday or Saturday (`footballWeekends`), and Claude does not say it is about a football weekend;
   - no date given is fine, unless the email mentions football, a game, kickoff, tailgating or a football weekend's name, or names a day Claude did not turn into a date (a weekday, today, tonight, tomorrow, this/next week or weekend, a month and day, 11/20, the 20th);
   - every weekday the email names (in its new text, not a quoted earlier message) is the weekday of one of Claude's dates, so "this Friday" resolved to a Thursday gets no reply;
   - no requested date is before the day the email was sent, and every date is readable.
4. **No one has answered yet.** The conversation has no Club message sent after the member's, no open draft, no newer message from anyone, and no message already tagged "OpenTable: Replied" (or "Sending"). So a conversation gets at most one OpenTable reply. If the conversation as read does not include the member's own message, there is no reply.

## The reply

`Re: <the original subject>` (the subject as is when it already starts with "Re:"), as an Outlook reply (so it threads and quotes the original), **to the member who wrote only** (Reply-To if set, else From): no Cc, no Bcc, never reply-all. Before sending, the workflow checks the saved draft has exactly that one recipient.

```
Hello <First name>,

We look forward to hosting you!

For groups of six or fewer, OpenTable is the quickest way to book reservations at the Club:

Book Upstairs:
<links.upstairs>

Book Downstairs:
<links.downstairs>

If your group is seven or larger, reply back "LARGE GROUP" and we will take it from there.

Sincerely,
/claude
```

The links are clickable, with the address itself as the text. **First name** is the CRM's First Name (column D) when the member wrote, or Spouse's First Name (column M) when the spouse wrote; if that cell is blank, the first word of Display Name (B) or Spouse's Display Name (L) (unless it is a title such as "Mrs."); if still blank, the note starts "Hello," with no name.

## The tags (Outlook categories)

| Tag | Meaning |
|---|---|
| OpenTable: Replied | The OpenTable note was sent. |
| OpenTable: No Reply | Looked at; no note sent (not a member, not a simple table request, too many people, a football date, already answered...). Answer it as usual. |
| OpenTable: Needs Review | Something failed (Outlook, the CRM or Claude). No note was sent, unless "Sending" is also on it (see below). |
| OpenTable: Sending | Put on just before the reply is created, swapped for "Replied" after it is sent. An email still carrying it was being answered when something went wrong: **check Sent Items** to see whether the note went out. The workflow never touches it again, so it can never send twice. |

Tags are always added to the email's current categories, read again just before each change; the Secretary's and Football Reservations' tags are kept. If that read fails, the tag is not written (an untagged email is looked at again next check; one left on "Sending" never is). To color them, create the four categories in Outlook. To have an email looked at again, remove its "OpenTable: ..." tag while it is under 24 hours old.

## Changing it (`n8n/config/opentable.json`, then push)

| To change | Edit |
|---|---|
| The OpenTable links | `links.upstairs`, `links.downstairs` (must be https). |
| The largest party it answers | `maxPartySize`. The note's "six or fewer" and "seven or larger" follow it in words (1 to 11). |
| Football weekends | `footballWeekends`: add `{ "name": "Florida", "friday": "2027-10-29", "saturday": "2027-10-30" }`. The build checks the days. Past weekends can stay. |
| The wording of the note | `replyParagraphs` in `n8n/workflows/opentable-replies/code/decide.js`, and the expected text in `test/opentable-replies.test.mjs`. |
| What counts as a table request | `n8n/prompts/opentable-system.md` (what Claude is told). |
| Staff and automated senders | `staffDomains`, `automatedSenders`. |
| Timing | `schedule` (every `everyMinutes` from `atMinute`), `settleMinutes` (how long new mail waits so a quick follow-up can land first), `lookbackHours`, `maxPerRun`, `runBudgetMinutes` (at most 4: the run's limit is this plus 10 minutes and must stay under the 15-minute schedule). |
| The model | `model`, `effort`, `maxTokens`. |
| The tags | `categories` (four different names). |

`processReceivedAfter` keeps it from answering mail that arrived before it was switched on. To turn it off, set `"opentable-replies": { "active": false }` in `n8n/deploy.json` and push.

## Good to know

- **Credentials.** It uses the existing `1892 Secretary Outlook`, `1892 Anthropic` and `1892 Google Sheets` credentials (see [Football Reservations](football.md#set-up-once)).
- **Football weekends** go through the football request sheet ([Football Reservations](football.md)), so those emails are never answered here.
- **Secretary Inbox.** If the Secretary Inbox workflow is turned on, it may also answer the same email; this workflow waits while that one has the email tagged as in progress, and skips a conversation the Club has already answered.
- **Privacy.** n8n keeps no record of successful runs (they contain member email). Failed runs are kept for debugging. Claude sees only the one email, never the CRM.
- **Costs.** One Claude call per member email that passes the first checks; a check with nothing new makes one Outlook call and stops.
