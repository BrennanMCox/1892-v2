import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAll } from '../scripts/lib/build.mjs';
import { deployAll, nodeId } from '../scripts/lib/deploy.mjs';
import { N8nClient } from '../scripts/lib/n8n-client.mjs';

// Most tests deploy just the Secretary Inbox; the last one deploys everything.
const everything = await buildAll();
const built = everything.filter((b) => b.meta.key === 'secretary-inbox');

// A tiny in-memory n8n public API.
function fakeN8n({ noFolders = false, projectsForbidden = false, projects = [{ id: 'p1', name: '1892' }], credentials = [], workflows = [], v1 = false, noCredList = false, noProjectIdOnCreate = false } = {}) {
  const state = { workflows: structuredClone(workflows), calls: [] };
  let seq = 100;
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v1', '');
    const method = opts.method;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push(`${method} ${path}`);
    assert.equal(opts.headers['X-N8N-API-KEY'], 'key');
    if (method === 'GET' && path === '/projects') {
      return projectsForbidden ? json(403, { message: 'Your license does not allow for feat:projectRole:admin.' }) : json(200, { data: projects, nextCursor: null });
    }
    if (method === 'GET' && path === '/credentials') return noCredList ? json(404, { message: 'not found' }) : json(200, { data: credentials });
    if (method === 'GET' && path === '/workflows') {
      const pid = u.searchParams.get('projectId');
      return json(200, { data: state.workflows.filter((w) => !pid || w.projectId === pid), nextCursor: null });
    }
    let m = path.match(/^\/workflows\/([^/]+)$/);
    if (m && method === 'GET') return json(200, state.workflows.find((w) => w.id === m[1]));
    if (m && method === 'PUT') {
      if (body.parentFolderId && noFolders) return json(400, { message: "request/body must NOT have additional properties 'parentFolderId'" });
      for (const k of Object.keys(body)) assert.ok(['name', 'nodes', 'connections', 'settings', 'parentFolderId'].includes(k), `unexpected PUT key ${k}`);
      const w = state.workflows.find((x) => x.id === m[1]);
      Object.assign(w, body);
      return json(200, w);
    }
    if (method === 'POST' && path === '/workflows') {
      if (body.projectId && noProjectIdOnCreate) return json(400, { message: 'request/body must NOT have additional properties' });
      if (body.parentFolderId && noFolders) return json(400, { message: "request/body must NOT have additional properties 'parentFolderId'" });
      for (const k of Object.keys(body)) assert.ok(['name', 'nodes', 'connections', 'settings', 'projectId', 'parentFolderId'].includes(k), `unexpected body key ${k}`);
      const w = { id: `w${(seq += 1)}`, active: false, projectId: body.projectId, ...body };
      state.workflows.push(w);
      return json(200, w);
    }
    m = path.match(/^\/workflows\/([^/]+)\/(transfer|publish|activate|deactivate|unpublish)$/);
    if (m) {
      const w = state.workflows.find((x) => x.id === m[1]);
      if (m[2] === 'transfer') w.projectId = body.destinationProjectId;
      if (m[2] === 'publish') {
        if (v1) return json(404, { message: 'not found' });
        w.active = true;
      }
      if (m[2] === 'activate') w.active = true;
      if (m[2] === 'deactivate' || m[2] === 'unpublish') w.active = false;
      return json(200, w);
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
  return { state, client: new N8nClient({ baseUrl: 'https://x.app.n8n.cloud/', apiKey: 'key', fetchImpl, retries: 1 }) };
}

const cfg = (over = {}) => ({
  project: '1892',
  workflows: { 'secretary-inbox': { active: false } },
  credentials: { microsoftOutlookOAuth2Api: { name: 'Outlook' }, anthropicApi: { name: 'Anthropic' } },
  ...over,
});
const quiet = () => {};

describe('deploy', () => {
  test('creates the workflow in the 1892 project, with credentials found by name', async () => {
    const n8n = fakeN8n({ credentials: [{ id: 'c1', name: 'Outlook', type: 'microsoftOutlookOAuth2Api' }, { id: 'c2', name: 'Anthropic', type: 'anthropicApi' }] });
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    const w = n8n.state.workflows[0];
    assert.equal(w.projectId, 'p1');
    assert.equal(w.name, 'Secretary Inbox');
    assert.deepEqual(r.missing, []);
    assert.equal(w.nodes.find((n) => n.name === 'Ask Claude').credentials.anthropicApi.id, 'c2');
    assert.ok(!w.nodes.some((n) => n.type.includes('Trigger') && n.credentials && !n.credentials.microsoftOutlookOAuth2Api?.id));
    assert.equal(w.nodes.find((n) => n.name === 'List Inbox').credentials.microsoftOutlookOAuth2Api.id, 'c1');
    assert.ok(w.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote'));
    assert.equal(w.active, false);
  });

  test('second deploy updates in place, keeps hand-set credentials, and keeps node ids', async () => {
    const n8n = fakeN8n({ noCredList: true });
    await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    assert.equal(n8n.state.workflows.length, 1);
    // Someone picks credentials in the n8n UI.
    for (const n of n8n.state.workflows[0].nodes) {
      if (n.credentials || n.parameters.nodeCredentialType || n.type.endsWith('microsoftOutlookTrigger')) {
        const type = n.parameters.nodeCredentialType || 'microsoftOutlookOAuth2Api';
        n.credentials = { [type]: { id: `hand-${type}`, name: 'set by hand' } };
      }
    }
    const before = n8n.state.workflows[0].nodes.map((n) => n.id);
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    assert.equal(n8n.state.workflows.length, 1, 'no duplicate workflow');
    assert.deepEqual(r.missing, []);
    assert.equal(n8n.state.workflows[0].nodes.find((n) => n.name === 'Ask Claude').credentials.anthropicApi.id, 'hand-anthropicApi');
    assert.deepEqual(n8n.state.workflows[0].nodes.map((n) => n.id), before);
  });

  test('publishes when active, falling back to /activate on n8n 1.x', async () => {
    const n8n = fakeN8n({ v1: true });
    const config = cfg({ workflows: { 'secretary-inbox': { active: true } }, credentials: { microsoftOutlookOAuth2Api: { id: '7' }, anthropicApi: { id: '8' } } });
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: config, log: quiet });
    assert.equal(r.state, 'on');
    assert.ok(n8n.state.calls.some((c) => c.endsWith('/activate')));
    assert.equal(n8n.state.workflows[0].active, true);
  });

  test('never sends a credential without an id, and ignores credentials outside the project', async () => {
    const n8n = fakeN8n({ credentials: [{ id: 'cX', name: 'Outlook', type: 'microsoftOutlookOAuth2Api', shared: [{ id: 'other', name: 'Other' }] }] });
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    const nodes = n8n.state.workflows[0].nodes;
    for (const n of nodes) for (const ref of Object.values(n.credentials || {})) assert.ok(ref.id, n.name);
    assert.ok(!JSON.stringify(nodes).includes('"cX"'));
    assert.equal(r.state, 'off');
  });

  test('will not turn a workflow on while credentials are missing', async () => {
    const n8n = fakeN8n();
    const logs = [];
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: cfg({ workflows: { 'secretary-inbox': { active: true } } }), log: (l) => logs.push(l) });
    assert.equal(r.state, 'off');
    assert.ok(r.missing.length > 0);
    assert.match(logs.join('\n'), /NOT turning it on/);
    assert.ok(!n8n.state.calls.some((c) => /publish|activate/.test(c)));
  });

  test('turns a workflow off when deploy.json says active: false', async () => {
    const n8n = fakeN8n({ workflows: [{ id: 'w1', name: 'Secretary Inbox', active: true, projectId: 'p1', nodes: [] }] });
    const [r] = await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    assert.equal(r.state, 'off');
    assert.equal(n8n.state.workflows[0].active, false);
  });

  test('older n8n without projectId on create: creates, then transfers', async () => {
    const n8n = fakeN8n({ noProjectIdOnCreate: true });
    await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    assert.equal(n8n.state.workflows.length, 1);
    assert.equal(n8n.state.workflows[0].projectId, 'p1');
    assert.ok(n8n.state.calls.some((c) => c.endsWith('/transfer')));
  });

  test('without a project license, finds the project id through its credentials', async () => {
    const n8n = fakeN8n({ projectsForbidden: true, credentials: [{ id: 'c1', name: 'Outlook', type: 'microsoftOutlookOAuth2Api', shared: [{ id: 'p9', name: '1892' }] }] });
    await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    assert.equal(n8n.state.workflows[0].projectId, 'p9');
  });

  test('N8N_PROJECT_ID skips the project lookup', async () => {
    const n8n = fakeN8n({ projectsForbidden: true });
    await deployAll(built, { client: n8n.client, deployConfig: cfg({ projectId: 'p7' }), log: quiet });
    assert.equal(n8n.state.workflows[0].projectId, 'p7');
    assert.ok(!n8n.state.calls.includes('GET /projects'));
  });

  test('without a project license or a matching credential, says to set N8N_PROJECT_ID', async () => {
    const n8n = fakeN8n({ projectsForbidden: true });
    await assert.rejects(deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet }), /N8N_PROJECT_ID/);
  });

  test('a missing project is a clear error', async () => {
    const n8n = fakeN8n({ projects: [{ id: 'p0', name: 'Personal' }] });
    await assert.rejects(deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet }), /No n8n project named "1892"/);
  });

  test('deploys into the folder from n8n/deploy.json, and moves an existing workflow there', async () => {
    const n8n = fakeN8n({ projectsForbidden: true, workflows: [{ id: 'w1', name: 'Secretary Inbox', active: false, projectId: 'pC', parentFolderId: null, nodes: [] }] });
    const config = cfg({ project: 'Claude Code', projectId: 'pC', folderId: 'fD' });
    await deployAll(built, { client: n8n.client, deployConfig: config, log: quiet });
    assert.equal(n8n.state.workflows.length, 1);
    assert.equal(n8n.state.workflows[0].parentFolderId, 'fD');
    const fresh = fakeN8n({ projectsForbidden: true });
    await deployAll(built, { client: fresh.client, deployConfig: config, log: quiet });
    assert.equal(fresh.state.workflows[0].projectId, 'pC');
    assert.equal(fresh.state.workflows[0].parentFolderId, 'fD');
  });

  test('n8n without folder support in its API: saves at the project top level and says so', async () => {
    const n8n = fakeN8n({ noFolders: true });
    const logs = [];
    await deployAll(built, { client: n8n.client, deployConfig: cfg({ projectId: 'p1', folderId: 'fD' }), log: (l) => logs.push(l) });
    assert.equal(n8n.state.workflows.length, 1);
    assert.equal(n8n.state.workflows[0].parentFolderId, undefined);
    assert.match(logs.join('\n'), /Move it into the folder by hand/);
  });

  test('dry run changes nothing', async () => {
    const n8n = fakeN8n();
    await deployAll(built, { client: n8n.client, deployConfig: cfg(), dryRun: true, log: quiet });
    assert.equal(n8n.state.workflows.length, 0);
    assert.ok(n8n.state.calls.every((c) => c.startsWith('GET')));
  });

  test('deploys every workflow in n8n/workflows, each into the folder', async () => {
    const n8n = fakeN8n({ credentials: [{ id: 'c1', name: 'Outlook', type: 'microsoftOutlookOAuth2Api' }] });
    const results = await deployAll(everything, { client: n8n.client, deployConfig: cfg({ projectId: 'p1', folderId: 'fD' }), log: quiet });
    assert.deepEqual(results.map((r) => r.key).sort(), ['football-reservations', 'opentable-replies', 'secretary-export', 'secretary-inbox']);
    assert.deepEqual(n8n.state.workflows.map((w) => w.parentFolderId), ['fD', 'fD', 'fD', 'fD']);
    const exp = results.find((r) => r.key === 'secretary-export');
    assert.deepEqual(exp.missing, [], 'the export only needs the Outlook credential');
    const football = results.find((r) => r.key === 'football-reservations');
    assert.ok(football.missing.some((m) => /googleSheetsOAuth2Api/.test(m)), 'football needs the Google Sheets credential');
    assert.equal(football.state, 'off');
  });

  test('n8n without a credential list: asks n8n to bind credentials by name', async () => {
    const n8n = fakeN8n({ noCredList: true });
    await deployAll(built, { client: n8n.client, deployConfig: cfg(), log: quiet });
    const ref = n8n.state.workflows[0].nodes.find((n) => n.name === 'List Inbox').credentials.microsoftOutlookOAuth2Api;
    assert.deepEqual(ref, { id: null, name: 'Outlook' });
  });

  test('node ids are stable UUIDs', () => {
    assert.match(nodeId('k', 'Config'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(nodeId('k', 'Config'), nodeId('k', 'Config'));
    assert.notEqual(nodeId('k', 'Config'), nodeId('k', 'Decide'));
  });
});
