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

// Which window we're in (business hours or after hours), its reply goal, and
// when the next check runs. Mirrors the schedule built from cfg.schedule.
const S = cfg.schedule;
const B = S.businessHours;
const nowMs = Date.now();
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: S.timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs))
    .map((p) => [p.type, p.value]),
);
const minuteOfDay = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
const inBusiness = (t) => Math.floor(t / 60) >= B.startHour && Math.floor(t / 60) < B.endHour;
const pollAt = (t) => t % (inBusiness(t) ? B.pollMinutes : S.afterHours.pollMinutes) === 0;
let minutesToNextPoll = 1;
while (minutesToNextPoll < 1440 && !pollAt((minuteOfDay + minutesToNextPoll) % 1440)) minutesToNextPoll += 1;
const businessHours = inBusiness(minuteOfDay);
const replyWithinMinutes = (businessHours ? B : S.afterHours).replyWithinMinutes;
const nextPollAt = new Date(nowMs + minutesToNextPoll * 60000).toISOString();

return [{ json: { ...cfg, graphBase, since, listUrl, claim, businessHours, replyWithinMinutes, nextPollAt } }];
