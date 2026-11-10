#!/usr/bin/env node
// Builds every workflow in n8n/workflows into dist/<key>.json and validates it.
// The JSON can also be imported by hand in n8n (Workflow menu > Import from File).
//   node scripts/build.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAll, ROOT } from './lib/build.mjs';
import { prepareWorkflow } from './lib/deploy.mjs';

const built = await buildAll();
const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
for (const item of built) {
  const { body } = prepareWorkflow(item, { deployConfig: {}, credentialsByName: new Map(), existing: null });
  const file = join(dist, `${item.meta.key}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`built ${item.meta.name}: ${body.nodes.length} nodes -> dist/${item.meta.key}.json`);
}
