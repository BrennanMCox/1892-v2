# 1892

Automations for the 1892 Club, built as [n8n](https://n8n.io) workflows. GitHub is the source of truth: every push to the default branch deploys them to n8n, into a folder of the **Claude Code** project (set in `n8n/deploy.json`).

| Workflow | What it does |
|---|---|
| [Secretary Inbox Export](docs/replay.md) | Run by hand: saves recent secretary@ mail as drafts' attachments, to test the Secretary Inbox on real email. Sends nothing. |
| [Football Reservations](docs/football.md) | Keeps the "1892 Football Weekend Reservations" Google Sheet up to date from email to secretary@ every 15 minutes while a football weekend is open (every 5 minutes, usually within 6 to 12 minutes of an email, from the Wednesday to the Saturday of the weekend; longer after a burst, on a slow run, or while the Secretary Inbox is still working on it), replies to each new or changed request (to the member who wrote, in the same thread, with nothing quoted) with a fixed note that it is in the queue, and emails the Chef's covers report at 7 a.m. the Wednesday before. |
| [OpenTable Replies](docs/opentable.md) | Within about 15 minutes, answers member emails to secretary@ asking to book a table for six or fewer with a fixed note pointing them to OpenTable, to the member only. Football weekends, larger groups and anything unclear get no reply. |
| [Secretary Inbox](docs/secretary.md) | Answers email to secretary@1892club.com within 18 minutes from 7 a.m. to 7 p.m. (Eastern), and within 75 minutes overnight. Routine questions get a full reply; anything sensitive gets a holding reply plus a draft for the Club team to review. |

## Layout

```
n8n/
  deploy.json               which n8n project and folder, which workflows are on, credential names
  config/secretary.json     Secretary Inbox settings (shadow/live, limits, rules)
  config/football.json      Football Reservations settings (weekends, sheet, acknowledgement, Chef report)
  config/opentable.json     OpenTable Replies settings (links, party size, football dates)
  prompts/                  what Claude is told
  knowledge/club.md         the only facts Claude may state in a reply. Add to it.
  workflows/<key>/          one folder per workflow: workflow.mjs + code/*.js
scripts/                    build and deploy (plain Node.js, no dependencies)
test/                       tests for the workflow logic and the deploy
.github/workflows/          the GitHub Action that deploys
docs/                       setup and how-it-works guides
```

## Start here

1. [Set up the GitHub → n8n deploy](docs/n8n-deploy.md) (once).
2. [Go live with the Secretary Inbox](docs/secretary.md#going-live-safely).

```bash
npm test
```
