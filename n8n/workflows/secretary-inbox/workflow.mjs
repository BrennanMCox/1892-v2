// Builds the "Secretary Inbox" n8n workflow.
//
// How it works, in one breath: whenever new mail lands in the secretary@ inbox
// (Outlook trigger, checked every minute) and on a slower safety sweep, it lists
// recent Inbox mail, skips anything already tagged or machine-sent, tags the rest
// "working", asks Claude to classify and draft a reply, applies hard safety rules,
// then either sends the reply, or sends a short holding reply and leaves Claude's
// full draft in Drafts for Joel. Finally it tags the email so it is never
// answered twice.
//
// The node logic lives in ./code/*.js so it can be read and tested on its own.

export const meta = {
  key: 'secretary-inbox',
  name: 'Secretary Inbox',
  description:
    'Answers email to secretary@1892club.com within minutes. Managed in GitHub (n8n/workflows/secretary-inbox): edits made in n8n are overwritten on the next deploy.',
};

const OUTLOOK = 'microsoftOutlookOAuth2Api';
const ANTHROPIC = 'anthropicApi';

const CFG = "$('Config').first().json";
const GRAPH = `${CFG}.graphBase`;

export function build({ code, readJson, readText }) {
  const cfg = readJson('n8n/config/secretary.json');
  const clubFacts = readText('n8n/knowledge/club.md');
  const systemPrompt = readText('n8n/prompts/secretary-system.md').replace('{{CLUB_FACTS}}', clubFacts.trim());
  const replySchema = readJson('n8n/workflows/secretary-inbox/reply-schema.json');
  const { $comment, ...config } = cfg;

  const at = (col, row) => [col * 240, row * 200];

  const graph = (name, position, method, urlExpr, extra = {}) => ({
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      method,
      url: `=${urlExpr}`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: OUTLOOK,
      ...extra.parameters,
      options: { timeout: 30000, ...(extra.options || {}) },
    },
    credentials: { [OUTLOOK]: null },
    retryOnFail: true,
    maxTries: extra.maxTries ?? 3,
    waitBetweenTries: 3000,
    ...(extra.onError ? { onError: extra.onError } : {}),
  });

  const jsonBody = (expr) => ({ sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${expr}) }}` });

  const ifNode = (name, position, leftExpr, operation, rightValue) => ({
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
            leftValue: `={{ ${leftExpr} }}`,
            rightValue,
            operator:
              operation === 'true'
                ? { type: 'boolean', operation: 'true', singleValue: true }
                : { type: 'string', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
  });

  const codeNode = (name, position, file, mode, tokens = {}) => ({
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: {
      ...(mode === 'each' ? { mode: 'runOnceForEachItem' } : {}),
      jsCode: code(`n8n/workflows/secretary-inbox/code/${file}`, tokens),
    },
  });

  const nodes = [
    {
      name: 'New Mail',
      type: 'n8n-nodes-base.microsoftOutlookTrigger',
      typeVersion: 1,
      position: at(0, 0),
      parameters: {
        pollTimes: { item: [{ mode: 'everyMinute' }] },
        event: 'messageReceived',
        output: 'simple',
        filters: { readStatus: 'both' },
        options: {},
      },
      credentials: { [OUTLOOK]: null },
    },
    {
      name: 'Safety Sweep',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at(0, 1),
      parameters: {
        rule: { interval: [{ field: 'minutes', minutesInterval: config.sweepMinutes ?? 10 }] },
      },
    },
    codeNode('Config', at(1, 0.5), 'config.js', 'all', { CONFIG: config }),
    graph('List Inbox', at(2, 0.5), 'GET', `{{ ${GRAPH} }}/mailFolders/inbox/messages`, {
      parameters: {
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: '$filter', value: `=receivedDateTime ge {{ ${CFG}.since }}` },
            { name: '$orderby', value: 'receivedDateTime desc' },
            { name: '$top', value: '100' },
            {
              name: '$select',
              value:
                'id,conversationId,subject,from,sender,replyTo,toRecipients,ccRecipients,receivedDateTime,lastModifiedDateTime,categories,isDraft,webLink,body,bodyPreview,internetMessageHeaders',
            },
          ],
        },
      },
    }),
    codeNode('Select Messages', at(3, 0.5), 'select-messages.js', 'all'),
    ifNode('Real Person?', at(4, 0.5), '$json.route', 'equals', 'answer'),
    graph('Tag No Reply Needed', at(5, 1.5), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.id }}`, {
      parameters: jsonBody(`{ categories: [...$json.categories, ${CFG}.categories.skipped] }`),
    }),
    graph('Tag Working', at(5, 0), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.id }}`, {
      parameters: jsonBody(`{ categories: [...$json.categories.filter(c => c !== ${CFG}.categories.processing), ${CFG}.categories.processing] }`),
    }),
    graph('Get Thread', at(6, 0), 'GET', `{{ ${GRAPH} }}/messages`, {
      parameters: {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: '$filter',
              value: "=conversationId eq '{{ $('Select Messages').item.json.conversationId.replace(/'/g, \"''\") }}'",
            },
            { name: '$select', value: 'id,from,sentDateTime,receivedDateTime,isDraft,body,bodyPreview' },
            { name: '$top', value: '25' },
          ],
        },
      },
      onError: 'continueRegularOutput',
    }),
    codeNode('Build Claude Request', at(7, 0), 'build-claude-request.js', 'each', {
      SYSTEM_PROMPT: systemPrompt,
      REPLY_SCHEMA: replySchema,
    }),
    {
      name: 'Ask Claude',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: at(8, 0),
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
        options: { timeout: 120000 },
      },
      credentials: { [ANTHROPIC]: null },
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 5000,
      onError: 'continueRegularOutput',
    },
    codeNode('Decide', at(9, 0), 'decide.js', 'all'),
    ifNode('Reply Job?', at(10, 0), '$json.kind', 'equals', 'reply'),
    ifNode('Notice Job?', at(11, 1), '$json.kind', 'equals', 'notify'),
    graph('Create Reply', at(11, 0), 'POST', `{{ ${GRAPH} }}/messages/{{ $json.messageId }}/{{ $json.replyAll ? 'createReplyAll' : 'createReply' }}`, {
      parameters: { sendBody: true, specifyBody: 'json', jsonBody: '{}' },
      maxTries: 2,
    }),
    codeNode('Fill Draft', at(12, 0), 'fill-draft.js', 'each'),
    graph('Save Draft', at(13, 0), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.draftId }}`, {
      parameters: jsonBody('$json.patch'),
    }),
    ifNode('Send Now?', at(14, 0), "$('Decide').item.json.send", 'true'),
    graph('Send Reply', at(15, -0.5), 'POST', `{{ ${GRAPH} }}/messages/{{ $('Fill Draft').item.json.draftId }}/send`, {
      // Graph wants a Content-Length on send; an empty JSON object provides one.
      parameters: { sendBody: true, specifyBody: 'json', jsonBody: '{}' },
      maxTries: 1,
    }),
    ifNode('Last Job?', at(16, 0), "!!$('Decide').item.json.finalize", 'true'),
    graph('Tag Done', at(17, 0.5), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $('Decide').item.json.messageId }}`, {
      parameters: jsonBody(
        "Object.assign({ categories: $('Decide').item.json.finalize.categories }, $('Decide').item.json.finalize.flag ? { flag: { flagStatus: 'flagged' } } : {})",
      ),
    }),
    graph('Send Notice', at(12, 1.5), 'POST', `{{ ${GRAPH} }}/sendMail`, {
      parameters: jsonBody(
        "{ message: { subject: $json.noticeSubject, body: { contentType: 'HTML', content: $json.noticeHtml }, toRecipients: $json.to.map(a => ({ emailAddress: { address: a } })) }, saveToSentItems: true }",
      ),
      maxTries: 1,
      onError: 'continueRegularOutput',
    }),
  ];

  const main = (...targets) => ({ main: targets.map((t) => (t ? t.map((node) => ({ node, type: 'main', index: 0 })) : [])) });

  const connections = {
    'New Mail': main(['Config']),
    'Safety Sweep': main(['Config']),
    Config: main(['List Inbox']),
    'List Inbox': main(['Select Messages']),
    'Select Messages': main(['Real Person?']),
    'Real Person?': main(['Tag Working'], ['Tag No Reply Needed']),
    'Tag Working': main(['Get Thread']),
    'Get Thread': main(['Build Claude Request']),
    'Build Claude Request': main(['Ask Claude']),
    'Ask Claude': main(['Decide']),
    Decide: main(['Reply Job?']),
    'Reply Job?': main(['Create Reply'], ['Notice Job?']),
    'Notice Job?': main(['Send Notice'], ['Tag Done']),
    'Create Reply': main(['Fill Draft']),
    'Fill Draft': main(['Save Draft']),
    'Save Draft': main(['Send Now?']),
    'Send Now?': main(['Send Reply'], ['Last Job?']),
    'Send Reply': main(['Last Job?']),
    'Last Job?': main(['Tag Done'], null),
  };

  return {
    name: meta.name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      executionTimeout: 300,
      timezone: 'America/New_York',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      saveExecutionProgress: true,
    },
  };
}
