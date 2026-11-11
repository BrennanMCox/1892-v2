// Builds the "Football Reservations" n8n workflow.
//
// In one breath: every 15 minutes, while a football weekend is open, it lists
// recent secretary@ mail (Inbox and Sent Items), skips what it has already
// tagged and anything automated, then takes the messages one at a time: reads
// the thread and the Requests tab fresh, asks Claude how the sheet should
// change, checks Claude's answer against the sheet's rules, writes columns A-W
// of the "1892 Football Weekend Reservations" sheet in one batch, and tags the
// email so it is never read twice. A message that fails anywhere is tagged
// "Reservations: Needs Review" and the run carries on with the next one.
// Before a sheet write the email is tagged "Needs Review" first, and that tag is
// swapped for "Logged" only after the write: if the run is cut off, or tagging
// fails, between the two, the email is left for a person instead of being read
// (and written) a second time.
//
// A second trigger, on Wednesday mornings, drafts (or sends) the chef's covers
// report for the weekend that starts two days later.
//
// It never emails members, and never writes columns X-AD (the Secretary's).
// The node logic lives in ./code/*.js so it can be read and tested on its own.

export const meta = {
  key: 'football-reservations',
  name: 'Football Reservations',
  description:
    'Keeps the "1892 Football Weekend Reservations" Google Sheet up to date from email to secretary@1892club.com, and emails the Wednesday covers report to the Chef. Never emails members. Managed in GitHub (n8n/workflows/football-reservations): edits made in n8n are overwritten on the next deploy.',
};

const OUTLOOK = 'microsoftOutlookOAuth2Api';
const SHEETS = 'googleSheetsOAuth2Api';
const ANTHROPIC = 'anthropicApi';
const CFG = "$('Config').first().json";
const DIR = 'n8n/workflows/football-reservations';

// Cron for the mail check: every `everyMinutes`, starting at `atMinute` past
// the hour, all day. The offset keeps it clear of the Secretary Inbox's checks,
// which start on the hour.
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

// Cron for the chef report: Wednesdays at chefReport.hour.
export function chefCron(report) {
  if (!(Number.isInteger(report.hour) && report.hour >= 0 && report.hour < 24)) throw new Error('chefReport.hour must be 0-23');
  return `0 ${report.hour} * * 3`;
}

export function build({ code, readJson, readText }) {
  const { $comment, ...config } = readJson('n8n/config/football.json');
  const systemPrompt = readText('n8n/prompts/football-system.md').trim();
  const actionsSchema = readJson(`${DIR}/actions-schema.json`);
  if (!['draft', 'send'].includes(config.chefReport?.mode)) throw new Error('chefReport.mode must be "draft" or "send"');
  if (!(Number.isInteger(config.runBudgetMinutes) && config.runBudgetMinutes >= 1 && config.runBudgetMinutes * 60 + 600 < config.schedule.everyMinutes * 60)) {
    throw new Error('runBudgetMinutes plus 10 minutes for the last message must stay under schedule.everyMinutes');
  }
  for (const w of config.weekends) {
    if (!/^[A-Z]+$/.test(w.prefix)) throw new Error(`weekend ${w.name}: prefix must be capital letters`);
    if (new Date(`${w.friday}T12:00:00Z`).getUTCDay() !== 5) throw new Error(`weekend ${w.name}: friday ${w.friday} is not a Friday`);
    if (new Date(`${w.saturday}T12:00:00Z`).getUTCDay() !== 6) throw new Error(`weekend ${w.name}: saturday ${w.saturday} is not a Saturday`);
    if (Number.isNaN(Date.parse(w.deadline))) throw new Error(`weekend ${w.name}: deadline is not a date`);
  }

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
  // The email's categories as they are now (a GET of the message), so a tag
  // another workflow or a person added meanwhile is kept when we PATCH.
  const recheck = (name, position, idExpr) =>
    graph(name, position, 'GET', `{{ ${CFG}.graphBase }}/messages/{{ ${idExpr} }}`, {
      parameters: { sendQuery: true, queryParameters: { parameters: [{ name: '$select', value: 'id,categories' }] } },
      onError: 'continueRegularOutput',
    });
  // Categories from the recheck just before (or, if it failed, the given fallback).
  const freshCats = (fallback) => `(Array.isArray($json.categories) ? $json.categories : ${fallback})`;

  const nodes = [
    {
      name: 'Every 15 Minutes',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at(0, 0),
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: mailCron(config.schedule) }] } },
    },
    codeNode('Config', at(1, 0), 'config.js', 'all', { CONFIG: config }),
    graph('List Mail', at(2, 0), 'GET', '{{ $json.listUrl }}', {
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
    codeNode('Queue Messages', at(5, 0), 'queue-messages.js', 'all'),
    {
      name: 'Loop Messages',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: at(6, 0),
      parameters: { batchSize: 1, options: {} },
    },
    ifTrue('Time Left?', at(7, 1), `Date.now() - Date.parse(${CFG}.startedAt) < ${CFG}.runBudgetMinutes * 60000`),
    graph('Get Thread', at(8, 1), 'GET', `{{ ${CFG}.graphBase }}/messages`, {
      parameters: {
        ...plainText,
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: '$filter', value: "=conversationId eq '{{ $('Loop Messages').item.json.conversationId.replace(/'/g, \"''\") }}'" },
            { name: '$select', value: 'id,from,sentDateTime,receivedDateTime,isDraft,body,bodyPreview' },
            { name: '$top', value: '50' },
          ],
        },
      },
      onError: 'continueErrorOutput',
    }),
    sheets('Read Requests', at(9, 1), 'GET', `{{ ${CFG}.requestsUrl }}`, { onError: 'continueErrorOutput' }),
    codeNode(
      'Build Claude Request',
      at(10, 1),
      'build-claude-request.js',
      'each',
      { SYSTEM_PROMPT: systemPrompt, ACTIONS_SCHEMA: actionsSchema },
      { onError: 'continueErrorOutput' },
    ),
    {
      // Asking again is safe (nothing is written yet), so a passing API error
      // gets one more try; after that the message is tagged for review.
      name: 'Ask Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: at(11, 1),
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
    // Read again right before writing: new IDs and new rows come from the sheet as it is now.
    sheets('Reread Requests', at(12, 1), 'GET', `{{ ${CFG}.requestsUrl }}`, { onError: 'continueErrorOutput' }),
    codeNode('Plan Writes', at(13, 1), 'plan-writes.js', 'each', {}, { onError: 'continueErrorOutput' }),
    ifTrue('Plan OK?', at(14, 1), "$json.route !== 'fail'"),
    ifTrue('Any Writes?', at(15, 0.5), "$json.route === 'write'"),
    // Tag the email "Needs Review" BEFORE writing. Tag Message swaps it for
    // "Logged" after the write; if the run is cut off or tagging fails in
    // between, the email stays "Needs Review" and is never written twice.
    recheck('Check Tags Before Write', at(16, 0), "$('Plan Writes').item.json.messageId"),
    graph('Mark Pending', at(17, 0), 'PATCH', `{{ ${CFG}.graphBase }}/messages/{{ $('Plan Writes').item.json.messageId }}`, {
      parameters: jsonBody(`{ categories: [...new Set([...${freshCats("$('Plan Writes').item.json.knownCategories")}, ${CFG}.categories.failed])] }`),
      onError: 'continueErrorOutput',
    }),
    // Never retried: a batch that went through but timed out must not be written twice.
    sheets('Write Sheet', at(18, 0), 'POST', `{{ ${CFG}.batchUpdateUrl }}`, {
      parameters: jsonBody("$('Plan Writes').item.json.body"),
      noRetry: true,
      onError: 'continueErrorOutput',
    }),
    recheck('Recheck Tags', at(19, 0.5), "$('Plan Writes').item.json.messageId"),
    // On the write path this also drops the "Needs Review" set by Mark Pending.
    graph('Tag Message', at(20, 0.5), 'PATCH', `{{ ${CFG}.graphBase }}/messages/{{ $('Plan Writes').item.json.messageId }}`, {
      parameters: jsonBody(
        `{ categories: [...new Set([...${freshCats("$('Plan Writes').item.json.knownCategories")}.filter((c) => $('Plan Writes').item.json.route !== 'write' || c !== ${CFG}.categories.failed), $('Plan Writes').item.json.tag])] }`,
      ),
      onError: 'continueRegularOutput',
    }),
    recheck('Recheck Failed Tags', at(19, 2.5), "$('Loop Messages').item.json.id"),
    graph('Tag Failed', at(20, 2.5), 'PATCH', `{{ ${CFG}.graphBase }}/messages/{{ $('Loop Messages').item.json.id }}`, {
      parameters: jsonBody(`{ categories: [...new Set([...${freshCats("($('Loop Messages').item.json.categories || [])")}, ${CFG}.categories.failed])] }`),
      onError: 'continueRegularOutput',
    }),

    // Chef report: Wednesday mornings.
    {
      name: 'Wednesday Morning',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at(0, 4),
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: chefCron(config.chefReport) }] } },
    },
    codeNode('Chef Config', at(1, 4), 'chef-config.js', 'all', { CONFIG: config }),
    sheets('Read Requests For Chef', at(2, 4), 'GET', '{{ $json.requestsUrl }}'),
    codeNode('Build Chef Report', at(3, 4), 'chef-report.js', 'all'),
    // Creating a message without sending it leaves it in Drafts.
    graph('Create Chef Draft', at(4, 4), 'POST', "{{ $('Chef Config').first().json.graphBase }}/messages", {
      parameters: jsonBody('$json.draft'),
      noRetry: true,
    }),
    ifTrue('Send Chef Report?', at(5, 4), "$('Build Chef Report').item.json.send === true"),
    graph('Send Chef Report', at(6, 4), 'POST', "{{ $('Chef Config').first().json.graphBase }}/messages/{{ $json.id }}/send", {
      noRetry: true,
    }),
  ];

  const main = (...targets) => ({ main: targets.map((t) => (t ? t.map((node) => ({ node, type: 'main', index: 0 })) : [])) });

  const connections = {
    'Every 15 Minutes': main(['Config']),
    Config: main(['List Mail']),
    'List Mail': main(['Select Messages']),
    'Select Messages': main(['Load CRM']),
    'Load CRM': main(['Queue Messages']),
    'Queue Messages': main(['Loop Messages']),
    // splitInBatches: output 0 is "done", output 1 is the next message.
    'Loop Messages': main(null, ['Time Left?']),
    'Time Left?': main(['Get Thread'], ['Loop Messages']),
    // Second outputs are errors: they go to Tag Failed (after re-reading the tags).
    'Get Thread': main(['Read Requests'], ['Recheck Failed Tags']),
    'Read Requests': main(['Build Claude Request'], ['Recheck Failed Tags']),
    'Build Claude Request': main(['Ask Claude'], ['Recheck Failed Tags']),
    'Ask Claude': main(['Reread Requests'], ['Recheck Failed Tags']),
    'Reread Requests': main(['Plan Writes'], ['Recheck Failed Tags']),
    'Plan Writes': main(['Plan OK?'], ['Recheck Failed Tags']),
    'Plan OK?': main(['Any Writes?'], ['Recheck Failed Tags']),
    'Any Writes?': main(['Check Tags Before Write'], ['Recheck Tags']),
    'Check Tags Before Write': main(['Mark Pending']),
    'Mark Pending': main(['Write Sheet'], ['Recheck Failed Tags']),
    'Write Sheet': main(['Recheck Tags'], ['Recheck Failed Tags']),
    'Recheck Tags': main(['Tag Message']),
    'Tag Message': main(['Loop Messages']),
    'Recheck Failed Tags': main(['Tag Failed']),
    'Tag Failed': main(['Loop Messages']),

    'Wednesday Morning': main(['Chef Config']),
    'Chef Config': main(['Read Requests For Chef']),
    'Read Requests For Chef': main(['Build Chef Report']),
    'Build Chef Report': main(['Create Chef Draft']),
    'Create Chef Draft': main(['Send Chef Report?']),
    'Send Chef Report?': main(['Send Chef Report'], null),
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
      // overlap. Should a run still be cut off mid-write, Mark Pending has
      // already tagged the email for review, so it is never written twice.
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
