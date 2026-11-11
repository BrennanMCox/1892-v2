# 1892

Automations for the 1892 Club, built as [n8n](https://n8n.io) workflows. GitHub is the source of truth: every push to the default branch deploys them to n8n, into a folder of the **Claude Code** project (set in `n8n/deploy.json`).

| Workflow | What it does |
|---|---|
| [Secretary Inbox Export](docs/replay.md) | Run by hand: saves recent secretary@ mail as drafts' attachments, to test the Secretary Inbox on real email. Sends nothing. |
| [Football Reservations](docs/football.md) | Keeps the "1892 Football Weekend Reservations" Google Sheet up to date from email to secretary@ every 15 minutes while a football weekend is open, and drafts the Chef's covers report the Wednesday before. Never emails members. |
| [Secretary Inbox](docs/secretary.md) | Answers email to secretary@1892club.com within 18 minutes from 7 a.m. to 7 p.m. (Eastern), and within 75 minutes overnight. Routine questions get a full reply; anything sensitive gets a holding reply plus a draft for the Club team to review. |

## Layout

```
n8n/
  deploy.json               which n8n project and folder, which workflows are on, credential names
  config/secretary.json     Secretary Inbox settings (shadow/live, limits, rules)
  config/football.json      Football Reservations settings (weekends, sheet, Chef report)
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
