import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMessages, threadMessages, parseAddresses } from '../scripts/lib/eml.mjs';
import { ROOT } from '../scripts/lib/build.mjs';

const DIR = join(ROOT, 'test', 'fixtures', 'emails');

test('reads .eml files: encoded subjects, quoted-printable and base64 bodies, Reply-To', () => {
  const { messages } = loadMessages(DIR);
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  const inq = byId['<inq-1@example.com>'];
  assert.equal(inq.subject, 'Dinner for six — Friday');
  assert.equal(inq.body.contentType, 'html');
  assert.match(inq.body.content, /Café au lait/);
  assert.equal(inq.receivedDateTime, '2026-11-02T19:05:00.000Z');
  assert.deepEqual(byId['<form-1@1892club.com>'].replyTo, [{ emailAddress: { name: 'Tom Hale', address: 'tom@example.org' } }]);
  assert.ok(byId['<news-1@wines.example>'].internetMessageHeaders.some((h) => h.name === 'List-Unsubscribe'));
});

test('threads a reply with the email it answers, and keeps separate emails apart', () => {
  const { messages } = loadMessages(DIR);
  threadMessages(messages);
  const conv = (id) => messages.find((m) => m.id === id).conversationId;
  assert.equal(conv('<inq-1@example.com>'), conv('<rep-1@1892club.com>'));
  assert.notEqual(conv('<inq-1@example.com>'), conv('<form-1@1892club.com>'));
});

test('parses address lists with quoted commas', () => {
  assert.deepEqual(parseAddresses('"Fox, Ann" <ann@x.com>, bob@y.com').map((a) => a.emailAddress.address), ['ann@x.com', 'bob@y.com']);
});

test('replay without Claude sorts the emails and finds the real reply', () => {
  const out = mkdtempSync(join(tmpdir(), 'replay-'));
  execFileSync(process.execPath, ['scripts/replay.mjs', DIR, '--out', out, '--no-claude'], { cwd: ROOT, stdio: 'pipe' });
  const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  const by = Object.fromEntries(results.map((r) => [r.subject, r]));
  assert.equal(by['November allocations'].route, 'skip');
  assert.equal(by['Membership inquiry'].route, 'answer');
  assert.equal(by['Dinner for six — Friday'].actualReply.minutes, 65);
  assert.match(by['Dinner for six — Friday'].request.messages[0].content, /Today is Mon, 02 Nov 2026 19:07/);
  assert.match(readFileSync(join(out, 'report.html'), 'utf8'), /"emails":3/);
});
