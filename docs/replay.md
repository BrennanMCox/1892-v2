# Testing on real email (replay)

`scripts/replay.mjs` runs exported secretary@ emails through the Secretary Inbox's own code, offline: the same sorting, the same Claude request, the same send-or-hold rules. It writes a report of what the workflow would have done next to what actually happened. It sends nothing and never touches the mailbox.

## 1. Export

### Easiest: the export workflow in n8n

The deploy also puts **Secretary Inbox Export** in the n8n folder. Open it and click **Execute workflow**. It reads the last 90 days of the secretary@ Inbox and Sent Items and saves them as `.json` attachments on one or more drafts named "Secretary export 1 of N" in secretary@'s **Drafts** folder. It sends nothing, changes no existing email, and keeps no copy in n8n's execution history. Download the attachments, give them to the replay, then delete the drafts.

### Or from Outlook

Export the secretary@ **Inbox** and **Sent Items** for the period you want (2–3 months is plenty) as `.eml` files, or as `.mbox`. Sent Items lets the report show the real reply from secretary@, and how long it took, next to each email.

- **Outlook for Mac:** select the emails (Cmd+A for all), drag them onto a folder in Finder.
- **Outlook on the web:** open an email, **⋯ → Download**. One at a time.
- **Classic Outlook for Windows** saves `.msg` files, which the replay can't read yet; use Outlook on the web.

These are members' private emails. Keep them out of the repository: `.gitignore` refuses `.eml`, `.mbox`, `.msg` and `.pst` files, and the `exports/` and `replay-out/` folders.

## 2. Run

```bash
node scripts/replay.mjs path/to/exported-folder --since 2026-09-01
```

The folder can hold `.json` files from the export workflow, `.eml` files and `.mbox` files.

```bash
node scripts/replay.mjs path/to/exported-folder --limit 20
```

- Without `ANTHROPIC_API_KEY` it only sorts the emails (real person or automated) and saves the Claude requests. That's free.
- With `ANTHROPIC_API_KEY` set, each real person's email goes to Claude exactly as the workflow would send it. Expect one Claude call per email, and see `inputTokens`/`outputTokens` in the summary.
- `--limit 20` tries the first 20 only. `--out folder` changes where the report goes (default `replay-out/`).

## 3. Read the report

Open `replay-out/report.html`. For each email it shows:

- what the workflow would do (send, hold for review, or no reply), and why;
- the reply it would send, and the draft it would leave for review;
- what secretary@ actually replied, and how long it took.

Use it to tune `n8n/knowledge/club.md` (missing facts are the usual reason for a hold), `n8n/prompts/secretary-system.md` and the rules in `n8n/config/secretary.json`, then run it again.
