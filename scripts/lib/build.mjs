// Turns n8n/workflows/<key>/workflow.mjs into importable n8n workflow JSON.
//
// A workflow module exports `meta` ({ key, name, description }) and
// `build(ctx)`, where ctx gives it:
//   readText(path), readJson(path): files relative to the repo root
//   code(path, tokens): a Code node script with each __TOKEN__ replaced by the
//                       JSON literal of tokens.TOKEN
// Nothing here talks to n8n; see deploy.mjs for that.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORKFLOWS_DIR = join(ROOT, 'n8n', 'workflows');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export function makeContext(root = ROOT) {
  const readText = (rel) => readFileSync(join(root, rel), 'utf8');
  const readJson = (rel) => JSON.parse(readText(rel));
  const code = (rel, tokens = {}) => {
    let src = readText(rel);
    for (const [name, value] of Object.entries(tokens)) {
      const token = `__${name}__`;
      if (!src.includes(token)) throw new Error(`${rel}: token ${token} is not used`);
      src = src.split(token).join(JSON.stringify(value, null, 2));
    }
    const left = src.match(/__[A-Z][A-Z0-9_]*__/);
    if (left) throw new Error(`${rel}: token ${left[0]} was not given a value`);
    try {
      // n8n runs Code node scripts as the body of an async function.
      // eslint-disable-next-line no-new
      new AsyncFunction(src);
    } catch (err) {
      throw new Error(`${rel}: JavaScript syntax error: ${err.message}`);
    }
    return src;
  };
  return { readText, readJson, code, root };
}

export function listWorkflowKeys(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'workflow.mjs')))
    .map((d) => d.name)
    .sort();
}

export async function buildWorkflow(key, root = ROOT) {
  const mod = await import(pathToFileURL(join(root, 'n8n', 'workflows', key, 'workflow.mjs')).href);
  if (!mod.meta || !mod.build) throw new Error(`${key}/workflow.mjs must export meta and build`);
  if (mod.meta.key !== key) throw new Error(`${key}/workflow.mjs: meta.key must be "${key}"`);
  const wf = mod.build(makeContext(root));
  validateWorkflow(wf, key);
  return { meta: mod.meta, workflow: wf };
}

export async function buildAll(root = ROOT) {
  const out = [];
  for (const key of listWorkflowKeys(join(root, 'n8n', 'workflows'))) out.push(await buildWorkflow(key, root));
  return out;
}

// Structural checks n8n itself would only report at import or run time.
export function validateWorkflow(wf, label = wf?.name) {
  const errors = [];
  if (!wf || typeof wf !== 'object') throw new Error(`${label}: build() returned nothing`);
  if (!wf.name) errors.push('missing name');
  if (!Array.isArray(wf.nodes) || !wf.nodes.length) errors.push('no nodes');
  const names = new Set();
  for (const n of wf.nodes || []) {
    if (!n.name) errors.push('a node has no name');
    if (names.has(n.name)) errors.push(`duplicate node name "${n.name}"`);
    names.add(n.name);
    if (!n.type || typeof n.typeVersion !== 'number') errors.push(`node "${n.name}" needs type and typeVersion`);
    if (!Array.isArray(n.position) || n.position.length !== 2) errors.push(`node "${n.name}" needs a position`);
    if (!n.parameters || typeof n.parameters !== 'object') errors.push(`node "${n.name}" needs parameters`);
  }
  const targeted = new Set();
  for (const [from, conn] of Object.entries(wf.connections || {})) {
    if (!names.has(from)) errors.push(`connection from unknown node "${from}"`);
    for (const output of conn.main || []) {
      for (const link of output || []) {
        if (!names.has(link.node)) errors.push(`connection from "${from}" to unknown node "${link.node}"`);
        targeted.add(link.node);
      }
    }
  }
  for (const n of wf.nodes || []) {
    const isTrigger = /trigger/i.test(n.type);
    if (!isTrigger && !targeted.has(n.name)) errors.push(`node "${n.name}" is not connected to anything`);
  }
  // Expressions that name a node must name a real one.
  const json = JSON.stringify(wf.nodes);
  for (const m of json.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) {
    if (!names.has(m[1])) errors.push(`an expression refers to unknown node "${m[1]}"`);
  }
  if (errors.length) throw new Error(`${label}: invalid workflow:\n  - ${errors.join('\n  - ')}`);
  return true;
}
