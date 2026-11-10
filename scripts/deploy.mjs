#!/usr/bin/env node
// Deploys every workflow in n8n/workflows to n8n.
//   N8N_BASE_URL=https://you.app.n8n.cloud N8N_API_KEY=... node scripts/deploy.mjs [--dry-run]
// In GitHub this runs from .github/workflows/deploy-n8n.yml on every push to main.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAll, ROOT } from './lib/build.mjs';
import { deployAll } from './lib/deploy.mjs';
import { N8nClient } from './lib/n8n-client.mjs';

const dryRun = process.argv.includes('--dry-run');
const deployConfig = JSON.parse(readFileSync(join(ROOT, 'n8n', 'deploy.json'), 'utf8'));
if (process.env.N8N_PROJECT_ID) deployConfig.projectId = process.env.N8N_PROJECT_ID;

const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
  : '';

try {
  const built = await buildAll();
  const client = new N8nClient({ baseUrl: process.env.N8N_BASE_URL, apiKey: process.env.N8N_API_KEY });
  const results = await deployAll(built, { client, deployConfig, dryRun, repoUrl });
  console.log('\nDone.');
  for (const r of results) {
    console.log(`  ${r.key}: ${r.action || r.state}${r.missing.length ? ` (${r.missing.length} credential warning(s))` : ''}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    const rows = results.map((r) => `| ${r.key} | ${r.id || ''} | ${r.action || r.state} | ${r.missing.join('<br>') || 'ok'} |`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['### n8n deploy', '', '| Workflow | n8n id | State | Credentials |', '|---|---|---|---|', ...rows, ''].join('\n'),
    );
  }
} catch (err) {
  console.error(`\nDeploy failed: ${err.message}`);
  process.exit(1);
}
