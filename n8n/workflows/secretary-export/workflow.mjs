// Builds the "Secretary Inbox Export" n8n workflow: a read-only, run-by-hand
// export of recent secretary@ mail for the offline replay test
// (scripts/replay.mjs, docs/replay.md).
//
// Run it with "Execute workflow" in n8n. It reads the Inbox and Sent Items for
// the last DAYS days and saves them as JSON attachments on draft emails in
// secretary@'s Drafts folder. It sends nothing and changes no existing email.

export const meta = {
  key: 'secretary-export',
  name: 'Secretary Inbox Export',
  description:
    'Run by hand: saves the last 90 days of secretary@ Inbox and Sent Items as JSON attachments on drafts in Drafts, for testing. Sends nothing. Managed in GitHub (n8n/workflows/secretary-export).',
};

const DAYS = 90;
const OUTLOOK = 'microsoftOutlookOAuth2Api';

export function build({ code, readJson }) {
  const { $comment, ...config } = readJson('n8n/config/secretary.json');
  const at = (col, row) => [col * 260, row * 200];
  const graphCall = (name, position, method, url, parameters, options = {}) => ({
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      method,
      url,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: OUTLOOK,
      ...parameters,
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, ...options },
    },
    credentials: { [OUTLOOK]: null },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  });

  const nodes = [
    { name: 'Run By Hand', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: at(0, 0), parameters: {} },
    {
      name: 'Export Settings',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at(1, 0),
      parameters: { jsCode: code('n8n/workflows/secretary-export/code/export-settings.js', { CONFIG: config, DAYS }) },
    },
    graphCall('Read Mail', at(2, 0), 'GET', '={{ $json.url }}', {
      // Plain-text bodies keep the export small.
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Prefer', value: 'outlook.body-content-type="text"' }] },
    }, {
      pagination: {
        pagination: {
          paginationMode: 'responseContainsNextURL',
          nextURL: '={{ $response.body["@odata.nextLink"] }}',
          paginationCompleteWhen: 'other',
          completeExpression: '={{ !$response.body["@odata.nextLink"] }}',
          limitPagesFetched: true,
          maxRequests: 80,
          requestInterval: 300,
        },
      },
    }),
    {
      name: 'Package',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at(3, 0),
      parameters: { jsCode: code('n8n/workflows/secretary-export/code/package.js') },
    },
    // Creating a message without sending it leaves it in Drafts.
    graphCall('Save As Draft', at(4, 0), 'POST', "={{ $('Export Settings').first().json.graphBase }}/messages", {
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.draft) }}',
    }),
  ];
  const main = (to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  return {
    name: meta.name,
    nodes,
    connections: {
      'Run By Hand': main('Export Settings'),
      'Export Settings': main('Read Mail'),
      'Read Mail': main('Package'),
      Package: main('Save As Draft'),
    },
    settings: {
      executionOrder: 'v1',
      executionTimeout: 1800,
      timezone: config.schedule.timezone,
      saveManualExecutions: false,
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'all',
    },
  };
}
