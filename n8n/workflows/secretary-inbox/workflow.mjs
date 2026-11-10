// Builds the "Secretary Inbox" n8n workflow.
//
// How it works, in one breath: every minute it lists recent Inbox mail, skips
// anything already tagged or machine-sent, tags the rest "working", asks Claude
// to classify and draft a reply, applies hard safety rules, then either sends
// the reply, or sends a short holding reply and leaves Claude's full draft in
// Drafts for Joel. Finally it tags the email so it is never answered twice.
// Any step that fails for an email flags that email for Joel.
//
// One schedule trigger, on purpose: runs start a minute apart, so two runs
// never pick up the same email (the "working" tag lands within seconds).
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

  // Outlook allows 4 requests at a time per mailbox; send at most 2 per node.
  // Retries repeat the whole node for every item, so steps that create or send
  // something never retry: they hand failures to "Tag Failed" instead.
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
      options: { timeout: 30000, batching: { batch: { batchSize: 2, batchInterval: 250 } }, ...(extra.options || {}) },
    },
    credentials: { [OUTLOOK]: null },
    ...(extra.noRetry ? { retryOnFail: false } : { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }),
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

  const tagBody = (ref) =>
    jsonBody(`Object.assign({ categories: ${ref}.categories }, ${ref}.flag ? { flag: { flagStatus: 'flagged' } } : {})`);

  const nodes = [
    {
      name: 'Every Minute',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at(0, 0.5),
      parameters: {
        rule: { interval: [{ field: 'minutes', minutesInterval: config.pollMinutes ?? 1 }] },
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
    graph('Tag Without Reply', at(5, 1.5), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.id }}`, {
      parameters: tagBody('$json.tagNow'),
      onError: 'continueRegularOutput',
    }),
    graph('Tag Working', at(5, 0), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.id }}`, {
      parameters: jsonBody('{ categories: $json.working }'),
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
            { name: '$top', value: '50' },
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
      // No node-level retry (it would re-ask Claude for every email). Decide
      // hands an email with a passing API error back for the next run instead.
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
        options: { timeout: 100000, batching: { batch: { batchSize: 5, batchInterval: 100 } } },
      },
      credentials: { [ANTHROPIC]: null },
      retryOnFail: false,
      onError: 'continueRegularOutput',
    },
    codeNode('Decide', at(9, 0), 'decide.js', 'all'),
    ifNode('Reply Job?', at(10, 0), '$json.kind', 'equals', 'reply'),
    ifNode('Notice Job?', at(11, 1.5), '$json.kind', 'equals', 'notify'),
    graph('Create Reply', at(11, 0), 'POST', `{{ ${GRAPH} }}/messages/{{ $json.messageId }}/{{ $json.replyAll ? 'createReplyAll' : 'createReply' }}`, {
      parameters: { sendBody: true, specifyBody: 'json', jsonBody: '{}' },
      noRetry: true,
      onError: 'continueErrorOutput',
    }),
    codeNode('Fill Draft', at(12, 0), 'fill-draft.js', 'each'),
    graph('Save Draft', at(13, 0), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $json.draftId }}`, {
      parameters: jsonBody('$json.patch'),
      onError: 'continueErrorOutput',
    }),
    ifNode('Send Now?', at(14, 0), "$('Decide').item.json.send", 'true'),
    graph('Send Reply', at(15, -0.5), 'POST', `{{ ${GRAPH} }}/messages/{{ $('Fill Draft').item.json.draftId }}/send`, {
      // No body, as n8n's own Outlook node does for drafts/send.
      noRetry: true,
      onError: 'continueErrorOutput',
    }),
    ifNode('Last Job?', at(16, 0), "!!$('Decide').item.json.finalize", 'true'),
    graph('Tag Done', at(17, 0.5), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $('Decide').item.json.messageId }}`, {
      parameters: tagBody("$('Decide').item.json.finalize"),
      onError: 'continueRegularOutput',
    }),
    graph('Tag Failed', at(17, 2), 'PATCH', `{{ ${GRAPH} }}/messages/{{ $('Decide').item.json.messageId }}`, {
      parameters: tagBody("$('Decide').item.json.failTag"),
      onError: 'continueRegularOutput',
    }),
    graph('Send Notice', at(12, 1.5), 'POST', `{{ ${GRAPH} }}/sendMail`, {
      parameters: jsonBody(
        "{ message: { subject: $json.noticeSubject, body: { contentType: 'HTML', content: $json.noticeHtml }, toRecipients: $json.to.map(a => ({ emailAddress: { address: a } })) }, saveToSentItems: true }",
      ),
      noRetry: true,
      onError: 'continueRegularOutput',
    }),
  ];

  const main = (...targets) => ({ main: targets.map((t) => (t ? t.map((node) => ({ node, type: 'main', index: 0 })) : [])) });

  const connections = {
    'Every Minute': main(['Config']),
    Config: main(['List Inbox']),
    'List Inbox': main(['Select Messages']),
    'Select Messages': main(['Real Person?']),
    'Real Person?': main(['Tag Working'], ['Tag Without Reply']),
    'Tag Working': main(['Get Thread']),
    'Get Thread': main(['Build Claude Request']),
    'Build Claude Request': main(['Ask Claude']),
    'Ask Claude': main(['Decide']),
    Decide: main(['Reply Job?']),
    'Reply Job?': main(['Create Reply'], ['Notice Job?']),
    'Notice Job?': main(['Send Notice'], ['Tag Done']),
    // Error outputs (second) of the steps that create or send go to Tag Failed.
    'Create Reply': main(['Fill Draft'], ['Tag Failed']),
    'Fill Draft': main(['Save Draft']),
    'Save Draft': main(['Send Now?'], ['Tag Failed']),
    'Send Now?': main(['Send Reply'], ['Last Job?']),
    'Send Reply': main(['Last Job?'], ['Tag Failed']),
    'Last Job?': main(['Tag Done'], null),
  };

  return {
    name: meta.name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      executionTimeout: 420,
      timezone: 'America/New_York',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      saveExecutionProgress: true,
    },
  };
}
