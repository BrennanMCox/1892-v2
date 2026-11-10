// Pushes built workflows into an n8n project. Idempotent: run it as often as
// you like; it creates a workflow the first time and updates it after that.
//
// Credentials never live in GitHub. Nodes are built with
// `credentials: { <type>: null }` and resolved here, in this order:
//   1. n8n/deploy.json credentials.<type>.id, if set;
//   2. the n8n credential with that type whose name matches credentials.<type>.name
//      (looked up with GET /credentials on n8n 2.8+);
//   3. whatever credential the same node already has in n8n (picked by hand once);
//   4. otherwise the node is sent with { id: null, name }, which n8n itself binds
//      to a same-named credential in the project when there is exactly one.
// After saving, the saved workflow is checked. If any node still has no
// credential, the workflow is left switched off so it can't fail every minute.

import { createHash } from 'node:crypto';

// Deterministic node ids, so ids stay put from deploy to deploy.
export function nodeId(workflowKey, nodeName) {
  const h = createHash('sha1').update(`${workflowKey}\u0000${nodeName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function managedNote(meta, repoUrl) {
  return {
    name: 'Managed in GitHub',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [0, -320],
    parameters: {
      content:
        `## ${meta.name}\n${meta.description || ''}\n\n` +
        `Source: ${repoUrl ? `${repoUrl}/tree/HEAD/` : ''}n8n/workflows/${meta.key}\n\n` +
        '**Do not edit this workflow in n8n.** Change it in GitHub; every push redeploys it and overwrites edits made here.',
      height: 260,
      width: 560,
    },
  };
}

// Builds the create/update body. `unresolved` lists credentials left for n8n to
// bind by name; `problems` lists ones that can't be bound at all.
export function prepareWorkflow({ meta, workflow }, { deployConfig = {}, credentialsByName = new Map(), existing = null, repoUrl = '' } = {}) {
  const existingNodes = new Map((existing?.nodes || []).map((n) => [n.name, n]));
  const unresolved = [];
  const problems = [];
  const nodes = [...workflow.nodes, managedNote(meta, repoUrl)].map((node) => {
    const out = { id: nodeId(meta.key, node.name), ...node };
    if (!node.credentials) return out;
    const creds = {};
    for (const [type, given] of Object.entries(node.credentials)) {
      const wanted = deployConfig.credentials?.[type] || {};
      let ref = given?.id ? given : null;
      if (!ref && wanted.id) ref = { id: String(wanted.id), name: wanted.name || '' };
      if (!ref && wanted.name) {
        const matches = (credentialsByName.get(wanted.name) || []).filter((c) => !c.type || c.type === type);
        if (matches.length === 1) ref = { id: String(matches[0].id), name: matches[0].name };
        if (matches.length > 1) problems.push(`${node.name}: ${matches.length} "${type}" credentials are named "${wanted.name}"; put the right id in n8n/deploy.json`);
      }
      if (!ref) {
        const prev = existingNodes.get(node.name)?.credentials?.[type];
        if (prev?.id) ref = { id: String(prev.id), name: prev.name || '' };
      }
      if (!ref && wanted.name) {
        ref = { id: null, name: wanted.name };
        unresolved.push(`${node.name}: "${type}" credential "${wanted.name}" (left for n8n to match by name)`);
      }
      if (ref) creds[type] = ref;
      else problems.push(`${node.name}: no "${type}" credential configured in n8n/deploy.json`);
    }
    if (Object.keys(creds).length) out.credentials = creds;
    else delete out.credentials;
    return out;
  });
  return {
    body: { name: workflow.name, nodes, connections: workflow.connections, settings: workflow.settings || {} },
    unresolved,
    problems,
  };
}

// Which credentials the saved workflow is still missing.
export function missingCredentials(saved, built) {
  const savedNodes = new Map((saved?.nodes || []).map((n) => [n.name, n]));
  const missing = [];
  for (const node of built.nodes) {
    for (const type of Object.keys(node.credentials || {})) {
      const ref = savedNodes.get(node.name)?.credentials?.[type];
      if (!ref?.id) missing.push(`${node.name}: no "${type}" credential`);
    }
  }
  return missing;
}

// The project to deploy into. GET /projects needs an n8n license with project
// admin roles, so also accept an id (N8N_PROJECT_ID, from the project's URL in
// n8n) or find the project through the credentials shared with it.
async function findProject(client, { project: projectName, projectId }, log) {
  if (projectId) return { id: projectId, name: projectName || projectId };
  if (!projectName) return null;
  let projects = null;
  try {
    projects = await client.listProjects();
  } catch (err) {
    if (![401, 403, 404].includes(err.status)) throw err;
    log(`  note: this n8n API key can't list projects (HTTP ${err.status}); looking for "${projectName}" through its credentials.`);
  }
  if (projects) {
    const matches = projects.filter((p) => p.name === projectName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`More than one n8n project is named "${projectName}". Set N8N_PROJECT_ID.`);
    const names = projects.map((p) => `"${p.name}"`).join(', ') || 'none';
    throw new Error(`No n8n project named "${projectName}". Create it in n8n first (projects found: ${names}).`);
  }
  try {
    const ids = new Set();
    for (const c of await client.listCredentials()) {
      for (const s of c.shared || []) if (s.name === projectName && s.id) ids.add(s.id);
    }
    if (ids.size === 1) return { id: [...ids][0], name: projectName };
  } catch {
    /* fall through */
  }
  throw new Error(
    `Could not find the n8n project "${projectName}". Open the project in n8n, copy the id from the address bar ` +
      '(…/projects/<id>/workflows), and save it as the N8N_PROJECT_ID secret in GitHub.',
  );
}

async function loadCredentials(client, log) {
  const byName = new Map();
  try {
    for (const c of await client.listCredentials()) {
      if (!byName.has(c.name)) byName.set(c.name, []);
      byName.get(c.name).push(c);
    }
  } catch (err) {
    log(`  note: this n8n can't list credentials (HTTP ${err.status ?? '?'}); n8n will match them by name instead.`);
  }
  return byName;
}

export async function deployAll(built, { client, deployConfig, dryRun = false, repoUrl = '', log = console.log }) {
  const project = await findProject(client, deployConfig, log);
  log(project ? `n8n project: "${project.name}" (${project.id})` : 'n8n project: none (personal space)');

  const credentialsByName = await loadCredentials(client, log);
  const all = await client.listWorkflows(project ? { projectId: project.id } : {});
  const results = [];
  let failed = false;

  for (const item of built) {
    const { meta, workflow } = item;
    const want = deployConfig.workflows?.[meta.key] || {};
    log(`\n${meta.name} (${meta.key})`);
    const same = all.filter((w) => w.name === workflow.name && !w.isArchived);
    if (same.length > 1) {
      log(`  ERROR: ${same.length} workflows in the project are named "${workflow.name}". Delete or rename the extras.`);
      failed = true;
      continue;
    }
    const existing = same[0] ? await client.getWorkflow(same[0].id) : null;
    const { body, unresolved, problems } = prepareWorkflow(item, { deployConfig, credentialsByName, existing, repoUrl });
    for (const m of [...problems, ...unresolved]) log(`  note: ${m}`);

    if (dryRun) {
      log(`  dry run: would ${existing ? `update workflow ${existing.id}` : 'create it'}${want.active ? ', then turn it on if its credentials are set' : ''}`);
      results.push({ key: meta.key, id: existing?.id, state: 'dry run', missing: problems });
      continue;
    }

    let saved;
    if (existing) {
      saved = await client.updateWorkflow(existing.id, body);
      log(`  updated workflow ${existing.id}`);
    } else {
      if (project) {
        try {
          saved = await client.createWorkflow({ ...body, projectId: project.id });
        } catch (err) {
          if (err.status !== 400 || !/projectId|additional propert/i.test(err.message)) throw err;
          // n8n before 2.17 can't create straight into a project: create, then move.
          saved = await client.createWorkflow(body);
          await client.transferWorkflow(saved.id, project.id);
          saved = await client.getWorkflow(saved.id);
        }
      } else {
        saved = await client.createWorkflow(body);
      }
      log(`  created workflow ${saved.id}`);
    }
    const id = saved?.id || existing?.id;
    const missing = missingCredentials(saved?.nodes ? saved : await client.getWorkflow(id), workflow);
    for (const m of missing) log(`  missing: ${m}`);

    let state = (saved?.active ?? existing?.active) ? 'on' : 'off';
    if (want.active) {
      if (missing.length) {
        log('  NOT turning it on until those credentials exist in n8n (see docs/n8n-deploy.md).');
        if (state === 'on') {
          await client.unpublishWorkflow(id);
          state = 'off';
        }
      } else {
        await client.publishWorkflow(id);
        state = 'on';
        log('  turned on (published)');
      }
    } else if (state === 'on') {
      await client.unpublishWorkflow(id);
      state = 'off';
      log('  turned off, because n8n/deploy.json says active: false');
    } else {
      log('  left off (active: false in n8n/deploy.json)');
    }
    results.push({ key: meta.key, id, state, missing });
  }

  if (failed) throw new Error('Some workflows could not be deployed; see the errors above.');
  return results;
}
