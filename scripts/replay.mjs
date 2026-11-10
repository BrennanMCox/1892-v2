#!/usr/bin/env node
// Replays exported secretary@ emails through the Secretary Inbox logic,
// offline, and writes a report of what the workflow would have done.
// Nothing is sent and the mailbox is not touched.
//
//   node scripts/replay.mjs <folder-or-file> [--out replay-out] [--limit 50] [--since 2026-09-01] [--no-claude]
//
// Input: .eml files (one email each) and/or .mbox files, e.g. an Inbox export
// plus a Sent Items export. Sent mail from the mailbox is used as thread
// context and to compare the workflow's reply with the one actually sent.
// With ANTHROPIC_API_KEY set, each email really goes to Claude, exactly as
// the workflow would send it. Without it (or with --no-claude), only the
// sorting step runs, and the requests are saved for later.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildWorkflow, ROOT } from './lib/build.mjs';
import { runCode } from './lib/code-runner.mjs';
import { loadMessages, threadMessages } from './lib/eml.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input) {
  console.error('usage: node scripts/replay.mjs <folder-or-file> [--out replay-out] [--limit N] [--since YYYY-MM-DD] [--no-claude]');
  process.exit(2);
}
const outDir = resolve(opt('out', join(ROOT, 'replay-out')));
const limit = Number(opt('limit', '0')) || Infinity;
const since = opt('since') ? Date.parse(opt('since')) : 0;
const useClaude = !args.includes('--no-claude') && Boolean(process.env.ANTHROPIC_API_KEY);
const concurrency = Number(opt('concurrency', '3'));

const { workflow } = await buildWorkflow('secretary-inbox');
const js = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;
const askNode = workflow.nodes.find((n) => n.name === 'Ask Claude');
const headers = Object.fromEntries(askNode.parameters.headerParameters.parameters.map((h) => [h.name, h.value]));

// Config as the workflow computes it, but looking at every exported email
// regardless of age, and deciding as if live (so "would send" is visible).
const cfgRun = await runCode(js('Config'), { input: [{}] });
const cfg = { ...cfgRun.out[0].json, mode: 'live', processReceivedAfter: '1970-01-01T00:00:00Z', maxAgeHours: 1e7, maxPerRun: 1e9, notifyOnHold: [] };
const mailbox = String(cfg.mailboxAddress).toLowerCase();

const { messages, skipped } = loadMessages(resolve(input));
threadMessages(messages);
const fromAddr = (m) => String(m.from?.emailAddress?.address || '').toLowerCase();
const isOurs = (m) => fromAddr(m) === mailbox;
const byThread = new Map();
for (const m of messages) {
  if (!byThread.has(m.conversationId)) byThread.set(m.conversationId, []);
  byThread.get(m.conversationId).push(m);
}

const incoming = messages
  .filter((m) => !isOurs(m) && Date.parse(m.receivedDateTime) >= since)
  .sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime))
  .slice(0, limit);

console.log(`Read ${messages.length} emails (${messages.filter(isOurs).length} sent by ${mailbox}); replaying ${incoming.length} received.`);
if (skipped.length) console.log(`Skipped ${skipped.length} file(s) that are not .eml or .mbox (e.g. ${skipped[0]}).`);
console.log(useClaude ? `Asking ${cfg.model} for each email.` : 'Not calling Claude (no ANTHROPIC_API_KEY, or --no-claude): sorting only.');

// 1. Sort every email the way Select Messages does.
const selected = [];
for (const m of incoming) {
  const { out } = await runCode(js('Select Messages'), { input: [{ value: [m] }], nodes: { Config: [cfg] } });
  selected.push({ message: m, sel: out[0]?.json || null });
}

async function askClaude(request) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, ...headers },
      body: JSON.stringify(request),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    return { error: { message: `HTTP ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`, httpCode: res.status } };
  }
  return { error: { message: 'gave up after retries' } };
}

// 2. For each real person's email: build the request, ask Claude, decide.
const results = [];
let next = 0;
async function worker() {
  while (next < selected.length) {
    const item = selected[next];
    next += 1;
    const { message: m, sel } = item;
    const thread = byThread.get(m.conversationId) || [];
    const received = Date.parse(m.receivedDateTime);
    const actual = thread
      .filter((x) => isOurs(x) && Date.parse(x.sentDateTime) >= received)
      .sort((a, b) => Date.parse(a.sentDateTime) - Date.parse(b.sentDateTime))[0];
    const result = {
      id: m.id,
      subject: m.subject,
      from: fromAddr(m),
      fromName: m.from?.emailAddress?.name || '',
      received: m.receivedDateTime,
      preview: m.bodyPreview,
      route: sel?.route || 'not selected',
      skipReason: sel?.skipReason || '',
      actualReply: actual
        ? { sent: actual.sentDateTime, minutes: Math.round((Date.parse(actual.sentDateTime) - received) / 60000), text: actual.bodyPreview }
        : null,
    };
    if (sel?.route === 'answer') {
      const build = await runCode(js('Build Claude Request'), {
        mode: 'each',
        input: [{ value: thread }],
        nodes: { Config: [cfg], 'Select Messages': [{ ...sel, replayNow: new Date(received + 2 * 60000).toISOString() }] },
      });
      const ctx = build.out[0].json;
      result.request = ctx.request;
      if (useClaude) {
        const response = await askClaude(ctx.request);
        result.claude = response.error ? { error: response.error.message } : JSON.parse(response.content?.find((b) => b.type === 'text')?.text || 'null');
        result.usage = response.usage;
        const decide = await runCode(js('Decide'), {
          input: [{ id: m.id, categories: [...ctx.working, cfg.claim] }],
          nodes: { Config: [cfg], 'Build Claude Request': [{ ...ctx, retried: true }], 'Ask Claude': [response] },
        });
        const jobs = decide.out.map((o) => o.json);
        const last = jobs[jobs.length - 1];
        result.outcome = !last ? 'nothing' : last.finalize?.categories?.includes(cfg.categories.replied) ? 'send' : last.finalize?.categories?.includes(cfg.categories.skipped) ? 'no reply' : 'hold';
        result.why = (jobs.find((j) => j.log)?.log?.why) || [];
        result.sent = jobs.filter((j) => j.kind === 'reply' && j.send).map((j) => j.html);
        result.draftForJoel = jobs.filter((j) => j.kind === 'reply' && !j.send).map((j) => j.html);
      }
    }
    results.push(result);
    if (results.length % 10 === 0) console.log(`  ${results.length}/${selected.length}`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
results.sort((a, b) => Date.parse(a.received) - Date.parse(b.received));

// 3. Report.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const count = (f) => results.reduce((acc, r) => ((acc[f(r)] = (acc[f(r)] || 0) + 1), acc), {});
const summary = {
  emails: results.length,
  byRoute: count((r) => r.route),
  byOutcome: useClaude ? count((r) => r.outcome || '(skipped before Claude)') : null,
  byCategory: useClaude ? count((r) => r.claude?.category || '(none)') : null,
  answeredByJoel: results.filter((r) => r.actualReply).length,
  joelMedianMinutes: (() => {
    const v = results.filter((r) => r.actualReply).map((r) => r.actualReply.minutes).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })(),
  inputTokens: results.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0),
  outputTokens: results.reduce((s, r) => s + (r.usage?.output_tokens || 0), 0),
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const template = readFileSync(join(ROOT, 'scripts', 'replay-report.html'), 'utf8');
writeFileSync(
  join(outDir, 'report.html'),
  template.replace('/*__DATA__*/null', JSON.stringify({ summary, results, generated: new Date().toISOString(), usedClaude: useClaude }).replace(/</g, '\\u003c')),
);
console.log(`\n${JSON.stringify(summary, null, 2)}\n\nReport: ${join(outDir, 'report.html')}`);
