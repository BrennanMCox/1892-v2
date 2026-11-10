// Code node "Export Settings" (Run Once for All Items).
// One item per folder to read: the Graph URL for its last __DAYS__ days of mail.
// The whole query is in the URL so paging can follow @odata.nextLink.

const cfg = __CONFIG__;
const graphBase = `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`;
const days = __DAYS__;
const since = new Date(Date.now() - days * 86400000).toISOString();
const select = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'sender', 'replyTo', 'toRecipients',
  'ccRecipients', 'receivedDateTime', 'sentDateTime', 'isDraft', 'body', 'internetMessageHeaders',
].join(',');

return ['inbox', 'sentitems'].map((folder) => {
  const q = { $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc', $top: '50', $select: select };
  const url = `${graphBase}/mailFolders/${folder}/messages?${Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  return { json: { folder, url, graphBase, since, days, mailbox: cfg.mailboxAddress } };
});
