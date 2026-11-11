// Builds the "OpenTable Replies" n8n workflow.
//
// In one breath: every 15 minutes it lists recent secretary@ Inbox mail, keeps
// what a member wrote (not staff, not automated, not already handled), loads
// the CRM once, and takes the messages one at a time: checks the conversation
// has no Club reply and no OpenTable reply yet, asks Claude to describe the
// email (is it a new table request, for how many, which dates), checks that
// answer in code (party of 1 to maxPartySize, not a football Friday or
// Saturday), and only then sends the fixed OpenTable note to the member who
// wrote, and to nobody else. Everything else is tagged "OpenTable: No Reply".
//
// Idempotency: before the reply is created the email is tagged "OpenTable:
// Sending"; that tag is swapped for "OpenTable: Replied" after the send. A
// message carrying "Sending" is never picked up again, so a run cut off between
// the two can never send a second email; a person checks it instead. Any step
// that fails tags the email "OpenTable: Needs Review" and the run carries on.
//
// Claude never writes the reply: the text is a fixed template (code/decide.js).
// The node logic lives in ./code/*.js so it can be read and tested on its own.

export const meta = {
  key: 'opentable-replies',
  name: 'OpenTable Replies',
  description:
    'Answers member emails to secretary@1892club.com that ask to book a table for six or fewer with a fixed note pointing them to OpenTable, within about 15 minutes. When in doubt it does not reply. Managed in GitHub (n8n/workflows/opentable-replies): edits made in n8n are overwritten on the next deploy.',
};

const OUTLOOK = 'microsoftOutlookOAuth2Api';
const SHEETS = 'googleSheetsOAuth2Api';
const ANTHROPIC = 'anthropicApi';
const CFG = "$('Config').first().json";
const DIR = 'n8n/workflows/opentable-replies';

// Cron for the mail check: every `everyMinutes`, starting at `atMinute` past
// the hour. The offset keeps it clear of Football Reservations (:08, :23, ...).
export function mailCron(schedule) {
  const { everyMinutes, atMinute = 0 } = schedule;
  if (!(Number.isInteger(everyMinutes) && everyMinutes > 0 && everyMinutes <= 60 && 60 % everyMinutes === 0)) {
    throw new Error('schedule.everyMinutes must divide an hour evenly (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60)');
  }
  if (!(Number.isInteger(atMinute) && atMinute >= 0 && atMinute < everyMinutes)) {
    throw new Error('schedule.atMinute must be a whole number below everyMinutes');
  }
  const minutes = [];
  for (let m = atMinute; m < 60; m += everyMinutes) minutes.push(m);
  return `${minutes.join(',')} * * * *`;
}

export function build({ code, readJson, readText }) {
  const { $comment, ...config } = readJson('n8n/config/opentable.json');
  const systemPrompt = readText('n8n/prompts/opentable-system.md').trim();
  const decisionSchema = readJson(`${DIR}/decision-schema.json`);

  if (!(Number.isInteger(config.runBudgetMinutes) && config.runBudgetMinutes >= 1 && config.runBudgetMinutes * 60 + 600 < config.schedule.everyMinutes * 60)) {
    throw new Error('runBudgetMinutes plus 10 minutes for the last message must stay under schedule.everyMinutes');
  }
  // The reply says "six or fewer" / "seven or larger" in words.
  if (!(Number.isInteger(config.maxPartySize) && config.maxPartySize >= 1 && config.maxPartySize <= 11)) {
    throw new Error('maxPartySize must be a whole number from 1 to 11');
  }
  for (const w of config.footballWeekends || []) {
    if (new Date(`${w.friday}T12:00:00Z`).getUTCDay() !== 5) throw new Error(`football weekend ${w.name}: friday ${w.friday} is not a Friday`);
    if (new Date(`${w.saturday}T12:00:00Z`).getUTCDay() !== 6) throw new Error(`football weekend ${w.name}: saturday ${w.saturday} is not a Saturday`);
  }
  for (const k of ['upstairs', 'downstairs']) {
    if (!/^https:\/\/[^\s"<>]+$/.test(config.links?.[k] || '')) throw new Error(`links.${k} must be an https URL`);
  }
  const cats = Object.values(config.categories || {});
  if (cats.length !== 4 || new Set(cats).size !== 4 || !['replied', 'skipped', 'failed', 'sending'].every((k) => config.categories[k])) {
    throw new Error('categories must name four different tags: replied, skipped, failed, sending');
  }
  if (Number.isNaN(Date.parse(config.processReceivedAfter))) throw new Error('processReceivedAfter is not a date');

  const at = (col, row) => [col * 240, row * 200];

  const http = (cred, name, position, method, urlExpr, extra = {}) => ({
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      method,
      url: `=${urlExpr}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: cred,
      ...extra.parameters,
      options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: cred === OUTLOOK ? 1000 : 0 } }, ...(extra.options || {}) },
    },
    credentials: { [cred]: null },
    ...(extra.noRetry ? { retryOnFail: false } : { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }),
    ...(extra.onError ? { onError: extra.onError } : {}),
    ...(extra.executeOnce ? { executeOnce: true } : {}),
  });
  const graph = (...a) => http(OUTLOOK, ...a);
  const sheets = (...a) => http(SHEETS, ...a);

  const jsonBody = (expr) => ({ sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${expr}) }}` });
  const plainText = { sendHeaders: true, headerParameters: { parameters: [{ name: 'Prefer', value: 'outlook.body-content-type="text"' }] } };

  const ifTrue = (name, position, expr) => ({
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: `${name}-condition`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            leftValue: `={{ ${expr} }}`,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
  });

  const codeNode = (name, position, file, mode, tokens = {}, extra = {}) => ({
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: {
      ...(mode === 'each' ? { mode: 'runOnceForEachItem' } : {}),
      jsCode: code(`${DIR}/code/${file}`, tokens),
    },
    ...(extra.onError ? { onError: extra.onError } : {}),
  });

  const MSG_ID = "$('Loop Messages').item.json.id";
  // The email's categories as they are now (a GET of the message), so a tag
  // another workflow or a person added meanwhile is kept when we PATCH.
  // Its error output skips the tag write (never a write from stale categories).
  const recheck = (name, position, onError = 'continueErrorOutput') =>
    graph(name, position, 'GET', `{{ ${CFG}.graphBase }}/messages/{{ ${MSG_ID} }}`, {
      parameters: { sendQuery: true, queryParameters: { parameters: [{ name: '$select', value: 'id,categories' }] } },
      onError,
    });
  // Categories from the recheck just before. There is no fallback to the
  // categories as listed: a tag another workflow added since could be lost.
  // (A missing list throws, and the write is skipped.)
  const freshCats = '$json.categories';
  const tagPatch = (name, position, expr, onError = 'continueRegularOutput') =>
    graph(name, position, 'PATCH', `{{ ${CFG}.graphBase }}/messages/{{ ${MSG_ID} }}`, {
      parameters: jsonBody(`{ categories: ${expr} }`),
      onError,
    });
  const OURS = `[${CFG}.categories.replied, ${CFG}.categories.skipped, ${CFG}.categories.failed, ${CFG}.categories.sending]`;

  const nodes = [
    {
      name: 'Every 15 Minutes',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at(0, 0),
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: mailCron(config.schedule) }] } },
    },
    codeNode('Config', at(1, 0), 'config.js', 'all', { CONFIG: config }),
    graph('List Inbox', at(2, 0), 'GET', '{{ $json.listUrl }}', {
      parameters: plainText,
      options: {
        pagination: {
          pagination: {
            paginationMode: 'responseContainsNextURL',
            nextURL: '={{ $response.body["@odata.nextLink"] }}',
            paginationCompleteWhen: 'other',
            completeExpression: '={{ !$response.body["@odata.nextLink"] }}',
            limitPagesFetched: true,
            maxRequests: 20,
            requestInterval: 200,
          },
        },
      },
    }),
    codeNode('Select Messages', at(3, 0), 'select-messages.js', 'all'),
    sheets('Load CRM', at(4, 0), 'GET', `{{ ${CFG}.crmUrl }}`, { executeOnce: true }),
    codeNode('Match CRM', at(5, 0), 'match-crm.js', 'all'),
    {
      name: 'Loop Messages',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: at(6, 0),
      parameters: { batchSize: 1, options: {} },
    },
    ifTrue('Time Left?', at(7, 1), `Date.now() - Date.parse(${CFG}.startedAt) < ${CFG}.runBudgetMinutes * 60000`),
    ifTrue('Member?', at(8, 1), "$('Loop Messages').item.json.member === true"),
    graph('Get Thread', at(9, 1), 'GET', `{{ ${CFG}.graphBase }}/messages`, {
      parameters: {
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: '$filter', value: "=conversationId eq '{{ $('Loop Messages').item.json.conversationId.replace(/'/g, \"''\") }}'" },
            { name: '$select', value: 'id,from,sentDateTime,receivedDateTime,categories,isDraft' },
            { name: '$top', value: '100' },
          ],
        },
      },
      onError: 'continueErrorOutput',
    }),
    codeNode('Check Thread', at(10, 1), 'check-thread.js', 'each', {}, { onError: 'continueErrorOutput' }),
    ifTrue('Thread OK?', at(11, 1), '$json.ok === true'),
    codeNode(
      'Build Claude Request',
      at(12, 1),
      'build-claude-request.js',
      'each',
      { SYSTEM_PROMPT: systemPrompt, DECISION_SCHEMA: decisionSchema },
      { onError: 'continueErrorOutput' },
    ),
    {
      // Asking again is safe (nothing is sent yet), so a passing API error gets
      // one more try; after that the message is tagged for review.
      name: 'Ask Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: at(13, 1),
      parameters: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: ANTHROPIC,
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'anthropic-version', value: '2026-10-21' },
            { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
          ],
        },
        ...jsonBody('$json.request'),
        options: { timeout: 180000 },
      },
      credentials: { [ANTHROPIC]: null },
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 5000,
      onError: 'continueErrorOutput',
    },
    codeNode('Decide', at(14, 1), 'decide.js', 'each', {}, { onError: 'continueErrorOutput' }),
    ifTrue('Reply?', at(15, 1), "$json.route === 'reply'"),
    ifTrue('Decide Failed?', at(16, 2), "$json.route === 'fail'"),

    // Reply path. Recheck, then tag "Sending" BEFORE anything is created.
    recheck('Check Tags Before Send', at(16, 0), 'continueErrorOutput'),
    ifTrue('Still Untagged?', at(17, 0), `Array.isArray($json.categories) && !$json.categories.some((c) => ${OURS}.includes(c))`),
    tagPatch('Mark Sending', at(18, 0), `[...new Set([...${freshCats}, ${CFG}.categories.sending])]`, 'continueErrorOutput'),
    // Never retried: each call creates a draft.
    graph('Create Reply', at(19, 0), 'POST', `{{ ${CFG}.graphBase }}/messages/{{ ${MSG_ID} }}/createReply`, {
      parameters: { sendBody: true, specifyBody: 'json', jsonBody: '{}' },
      noRetry: true,
      onError: 'continueErrorOutput',
    }),
    codeNode('Build Reply', at(20, 0), 'build-reply.js', 'each', {}, { onError: 'continueErrorOutput' }),
    graph('Fill Reply', at(21, 0), 'PATCH', `{{ ${CFG}.graphBase }}/messages/{{ $json.draftId }}`, {
      parameters: jsonBody('$json.patch'),
      onError: 'continueErrorOutput',
    }),
    // The saved draft must go to exactly the one address, with no Cc or Bcc.
    ifTrue(
      'Draft OK?',
      at(22, 0),
      "Array.isArray($json.toRecipients) && $json.toRecipients.length === 1 && String($json.toRecipients[0].emailAddress?.address || '').toLowerCase() === $('Build Reply').item.json.to && !($json.ccRecipients || []).length && !($json.bccRecipients || []).length",
    ),
    // Never retried: a send that went through but timed out must not repeat.
    graph('Send Reply', at(23, 0), 'POST', `{{ ${CFG}.graphBase }}/messages/{{ $('Build Reply').item.json.draftId }}/send`, {
      noRetry: true,
      onError: 'continueErrorOutput',
    }),
    recheck('Recheck Replied Tags', at(24, 0)),
    tagPatch(
      'Tag Replied',
      at(25, 0),
      `[...new Set([...${freshCats}.filter((c) => c !== ${CFG}.categories.sending), ${CFG}.categories.replied])]`,
    ),

    // No reply.
    recheck('Recheck No Reply Tags', at(19, 3)),
    tagPatch('Tag No Reply', at(20, 3), `[...new Set([...${freshCats}, ${CFG}.categories.skipped])]`),

    // Something failed: a person checks it. A "Sending" tag already set stays.
    recheck('Recheck Failed Tags', at(19, 4.5)),
    tagPatch('Tag Failed', at(20, 4.5), `[...new Set([...${freshCats}, ${CFG}.categories.failed])]`),
  ];

  const main = (...targets) => ({ main: targets.map((t) => (t ? t.map((node) => ({ node, type: 'main', index: 0 })) : [])) });
  const FAIL = 'Recheck Failed Tags';
  const SKIP = 'Recheck No Reply Tags';

  const connections = {
    'Every 15 Minutes': main(['Config']),
    Config: main(['List Inbox']),
    'List Inbox': main(['Select Messages']),
    'Select Messages': main(['Load CRM']),
    'Load CRM': main(['Match CRM']),
    'Match CRM': main(['Loop Messages']),
    // splitInBatches: output 0 is "done", output 1 is the next message.
    'Loop Messages': main(null, ['Time Left?']),
    'Time Left?': main(['Member?'], ['Loop Messages']),
    'Member?': main(['Get Thread'], [SKIP]),
    // Second outputs of the steps that can fail are errors: they go to Tag Failed.
    'Get Thread': main(['Check Thread'], [FAIL]),
    'Check Thread': main(['Thread OK?'], [FAIL]),
    'Thread OK?': main(['Build Claude Request'], [SKIP]),
    'Build Claude Request': main(['Ask Claude'], [FAIL]),
    'Ask Claude': main(['Decide'], [FAIL]),
    'Decide': main(['Reply?'], [FAIL]),
    'Reply?': main(['Check Tags Before Send'], ['Decide Failed?']),
    'Decide Failed?': main([FAIL], [SKIP]),
    'Check Tags Before Send': main(['Still Untagged?'], [FAIL]),
    // Tagged meanwhile (another run, or a person): leave it alone.
    'Still Untagged?': main(['Mark Sending'], ['Loop Messages']),
    'Mark Sending': main(['Create Reply'], [FAIL]),
    'Create Reply': main(['Build Reply'], [FAIL]),
    'Build Reply': main(['Fill Reply'], [FAIL]),
    'Fill Reply': main(['Draft OK?'], [FAIL]),
    'Draft OK?': main(['Send Reply'], [FAIL]),
    'Send Reply': main(['Recheck Replied Tags'], [FAIL]),
    // A failed recheck skips the write. "Sending" then stays: never retried.
    'Recheck Replied Tags': main(['Tag Replied'], ['Loop Messages']),
    'Tag Replied': main(['Loop Messages']),
    // Untagged, the message is looked at again next run (nothing was sent).
    [SKIP]: main(['Tag No Reply'], ['Loop Messages']),
    'Tag No Reply': main(['Loop Messages']),
    [FAIL]: main(['Tag Failed'], ['Loop Messages']),
    'Tag Failed': main(['Loop Messages']),
  };

  return {
    name: meta.name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      // The loop stops taking new messages after runBudgetMinutes; the next
      // 10 minutes are room for the message in hand (Ask Claude alone can take
      // 2 x 180 s). Stays under the 15-minute schedule so two runs never
      // overlap. Should a run still be cut off mid-send, Mark Sending has
      // already tagged the email, so it is never answered twice.
      executionTimeout: config.runBudgetMinutes * 60 + 600,
      timezone: config.timezone,
      // Emails are private: keep failed runs for debugging, not successful ones.
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: true,
      saveExecutionProgress: false,
    },
  };
}
