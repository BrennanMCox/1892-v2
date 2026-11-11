// Code node "Config" (Run Once for All Items).
// The build script inlines n8n/config/opentable.json here. Edit that file in
// GitHub, not this node: every deploy overwrites it.
// Output: one item carrying the whole config plus the URLs the run uses.

const cfg = __CONFIG__;
const nowMs = Date.now();

const graphBase = `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`;
const a1 = (sheet, range) => `'${String(sheet).replace(/'/g, "''")}'!${range}`;
const crmUrl =
  `https://sheets.googleapis.com/v4/spreadsheets/${cfg.crm.spreadsheetId}/values/${encodeURIComponent(a1(cfg.crm.sheet, cfg.crm.range))}` +
  '?valueRenderOption=FORMATTED_VALUE';

// Only mail received after deploy (processReceivedAfter) and within the lookback.
const since = new Date(Math.max(Date.parse(cfg.processReceivedAfter) || 0, nowMs - cfg.lookbackHours * 3600 * 1000)).toISOString();
// The whole query lives in the URL so paging can follow @odata.nextLink as is.
// Inbox only: never Sent Items, never Drafts.
const query = {
  $filter: `receivedDateTime ge ${since}`,
  $orderby: 'receivedDateTime asc',
  $top: '50',
  $select: 'id,conversationId,subject,from,replyTo,toRecipients,ccRecipients,receivedDateTime,sentDateTime,categories,isDraft,body,internetMessageHeaders',
};
const qs = Object.entries(query)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  .join('&');

return [
  {
    json: {
      ...cfg,
      startedAt: new Date(nowMs).toISOString(),
      graphBase,
      since,
      crmUrl,
      listUrl: `${graphBase}/mailFolders/inbox/messages?${qs}`,
    },
  },
];
