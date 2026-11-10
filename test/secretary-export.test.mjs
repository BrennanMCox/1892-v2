import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflow } from '../scripts/lib/build.mjs';
import { runCode } from '../scripts/lib/code-runner.mjs';
import { fromGraph } from '../scripts/lib/eml.mjs';

const { workflow } = await buildWorkflow('secretary-export');
const js = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;

test('reads only: every Graph call is a GET except the one that saves drafts', () => {
  const calls = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  assert.deepEqual(calls.map((n) => [n.name, n.parameters.method]), [['Read Mail', 'GET'], ['Save As Draft', 'POST']]);
  assert.match(workflow.nodes.find((n) => n.name === 'Save As Draft').parameters.url, /\/messages$/);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none', 'member email is not kept in n8n execution logs');
});

test('asks for the Inbox and Sent Items of the last 90 days', async () => {
  const { out } = await runCode(js('Export Settings'), { input: [{}] });
  assert.deepEqual(out.map((o) => o.json.folder), ['inbox', 'sentitems']);
  const u = new URL(out[0].json.url);
  assert.equal(u.pathname, '/v1.0/me/mailFolders/inbox/messages');
  const since = Date.parse(u.searchParams.get('$filter').replace('receivedDateTime ge ', ''));
  assert.ok(Math.abs(Date.now() - since - 90 * 86400000) < 60000);
});

test('packages every page into draft-sized JSON attachments, without drafts or duplicates', async () => {
  const settings = { mailbox: 'secretary@1892club.com', since: '2026-08-12T00:00:00.000Z', graphBase: 'https://graph.microsoft.com/v1.0/me' };
  const big = 'x'.repeat(400000);
  const msg = (i, extra = {}) => ({ id: `g${i}`, internetMessageId: `<m${i}@x>`, subject: `s${i}`, receivedDateTime: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), body: { contentType: 'text', content: big }, internetMessageHeaders: [{ name: 'Received', value: 'noise' }, { name: 'In-Reply-To', value: '<m0@x>' }], ...extra });
  const pages = [{ value: [msg(1), msg(2), msg(3)] }, { value: [msg(3), msg(4), msg(5, { isDraft: true }), msg(6), msg(7)] }];
  const { out } = await runCode(js('Package'), { input: pages, nodes: { 'Export Settings': [settings] } });
  assert.equal(out.length, 2);
  const files = out.map((o) => JSON.parse(Buffer.from(o.json.draft.attachments[0].contentBytes, 'base64').toString('utf8')));
  assert.deepEqual(files.flatMap((f) => f.messages.map((m) => m.id)), ['g1', 'g2', 'g3', 'g4', 'g6', 'g7']);
  assert.deepEqual(files[0].messages[0].internetMessageHeaders.map((h) => h.name), ['In-Reply-To']);
  for (const o of out) assert.ok(o.json.draft.attachments[0].contentBytes.length < 3500000);
  assert.match(out[0].json.draft.subject, /^Secretary export 1 of 2/);
  assert.equal(out[0].json.draft.toRecipients, undefined, 'drafts have no recipients');
});

test('the replay reads exported Graph messages', () => {
  const m = fromGraph({ id: 'g1', internetMessageId: '<A@x>', conversationId: 'c1', subject: 'Hi', from: { emailAddress: { address: 'a@b.c' } }, receivedDateTime: '2026-10-01T00:00:00Z', body: { contentType: 'text', content: 'Hello  there' }, internetMessageHeaders: [{ name: 'In-Reply-To', value: '<Z@x>' }] });
  assert.equal(m.id, '<a@x>');
  assert.deepEqual(m.inReplyTo, ['<z@x>']);
  assert.equal(m.graphConversationId, 'c1');
  assert.equal(m.bodyPreview, 'Hello there');
});
