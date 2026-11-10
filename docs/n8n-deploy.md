# Deploying to n8n from GitHub

Every push to the repository's default branch runs `.github/workflows/deploy-n8n.yml`. It:

1. builds each workflow in `n8n/workflows/` into n8n's JSON format and checks it;
2. runs the tests in `test/`;
3. creates or updates each workflow in the n8n folder set in `n8n/deploy.json`: a folder in the **Claude Code** project (`projectId` and `folderId`, taken from the folder's address in n8n: `…/projects/<projectId>/folders/<folderId>/workflows`);
4. turns each workflow on or off to match `n8n/deploy.json`.

Pushes to other branches and pull requests run steps 1 and 2 only. To push to n8n without a code change, open **Actions → Deploy to n8n → Run workflow**. Tick **dry run** to see what would change without changing anything.

GitHub is the source of truth. Edits made inside n8n are overwritten on the next deploy, and each workflow carries a "Managed in GitHub" note on its canvas saying so.

## One-time setup

### 1. In n8n

1. **The folder.** Workflows go into the folder already set in `n8n/deploy.json`, in the Claude Code project. To use a different folder, open it in n8n and copy the two ids from the address bar into `projectId` and `folderId`.
2. **Create an API key.** Go to **Settings → n8n API → Create an API key**. If it asks for scopes, allow workflows (read, create, update, move, activate/publish) and credentials (list). The key's user needs edit rights in the Claude Code project.
3. **Create the credentials inside the Claude Code project.** Use these exact names, because the deploy looks them up by name:
   - **`1892 Secretary Outlook`**, type *Microsoft Outlook OAuth2 API*. Sign in as **secretary@1892club.com** itself, so the workflow reads and sends as that mailbox. The default scopes are enough.
   - **`1892 Anthropic`**, type *Anthropic*. Paste a Claude API key from console.anthropic.com.

   If you pick different names, change them in `n8n/deploy.json`. If two credentials share a name, put the right `id` there.

### 2. In GitHub

Go to **Settings → Environments → New environment** and name it `n8n`. You can require a reviewer there if you want to approve each deploy. Add these environment secrets:

| Secret | Value |
|---|---|
| `N8N_BASE_URL` | Your n8n address, e.g. `https://your-name.app.n8n.cloud` |
| `N8N_API_KEY` | The API key from step 1.2 |

### 3. First deploy

Push to the default branch, or run the action by hand. The log, and the run summary, show what it did, for example:

```
n8n project: "Claude Code" (bOu56IjitdBKxtyH)
n8n folder: (Dnl9ZPPNrgmyPU0B)
Secretary Inbox (secretary-inbox)
  created workflow 9f2…
  left off (active: false in n8n/deploy.json)
```

## Turning a workflow on

Set `"active": true` for it in `n8n/deploy.json` and push. The deploy only turns a workflow on when every node that needs a credential has one. Otherwise it says which are missing and leaves the workflow off, so it can't fail every minute.

## Running it from your computer

You need Node.js 20 or later. Nothing to install.

```bash
npm test
```

```bash
npm run build
```

`npm run build` writes `dist/<workflow>.json`. You can also import that file into n8n by hand (**Workflow menu → Import from File**).

```bash
N8N_BASE_URL=https://your-name.app.n8n.cloud N8N_API_KEY=... npm run deploy:dry-run
```

## Adding another workflow

Create `n8n/workflows/<key>/workflow.mjs`, exporting `meta` (`key`, `name`, `description`) and `build(ctx)`. Copy `secretary-inbox/workflow.mjs` as a starting point. Put Code node scripts in `code/` and add tests in `test/`. Then add `"<key>": { "active": false }` to `n8n/deploy.json`.

## Troubleshooting

| The log says | What to do |
|---|---|
| `Add the N8N_BASE_URL and N8N_API_KEY secrets` | Do step 2. |
| `n8n folder … was not found` | The folder was moved or deleted. Update `folderId` in `n8n/deploy.json`. |
| `cannot place workflows in folders through its API` | Your n8n is older than 2.20. The workflow is saved at the top of the project; drag it into the folder once. Later deploys leave it there. |
| `missing: … no "anthropicApi" credential` | Create the credential with the name in `n8n/deploy.json`, inside the Claude Code project, then re-run. |
| `HTTP 401` | The API key is wrong or was deleted. Make a new one and update the secret. |
| `HTTP 403` when turning a workflow on | The API key isn't allowed to publish workflows in that project. |
