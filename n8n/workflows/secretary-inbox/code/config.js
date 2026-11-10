// Code node "Config" (Run Once for All Items).
// The build script inlines n8n/config/secretary.json here. Edit that file in
// GitHub, not this node: every deploy overwrites it.

const cfg = __CONFIG__;
const graphBase = `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`;
const since = new Date(
  Math.max(Date.parse(cfg.processReceivedAfter) || 0, Date.now() - cfg.maxAgeHours * 3600 * 1000),
).toISOString();

// The whole query lives in the URL (not separate query fields) so that paging
// can follow Graph's @odata.nextLink without n8n adding the query twice.
const select = [
  'id', 'conversationId', 'subject', 'from', 'sender', 'replyTo', 'toRecipients', 'ccRecipients',
  'receivedDateTime', 'lastModifiedDateTime', 'categories', 'isDraft', 'webLink', 'body', 'bodyPreview',
  'internetMessageHeaders',
].join(',');
const query = {
  $filter: `receivedDateTime ge ${since}`,
  $orderby: 'receivedDateTime desc',
  $top: '50',
  $select: select,
};
const listUrl = `${graphBase}/mailFolders/inbox/messages?${Object.entries(query)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  .join('&')}`;

// This run's claim tag. Tag Working adds it; Check Claim makes sure no other
// run has claimed the same email since, before anything is sent.
const claim = `${cfg.categories.claimPrefix}${$execution.id}`;

return [{ json: { ...cfg, graphBase, since, listUrl, claim } }];
