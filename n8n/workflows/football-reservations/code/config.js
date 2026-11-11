// Code node "Config" (Run Once for All Items).
// The build script inlines n8n/config/football.json here. Edit that file in
// GitHub, not this node: every deploy overwrites it.
// Output: one item per mail folder to read (Inbox, Sent Items), each carrying
// the whole config, or nothing at all (the run then stops here) when no
// football weekend is open, or when this run was started by the trigger that
// is not the one for today:
//   - game days (Wednesday to Saturday of a football weekend, Eastern time):
//     only "Game Days" (every gameDays.pollMinutes) reads mail, with
//     gameDays.settleMinutes; a run of "Every 15 Minutes" stops here;
//   - other days: only "Every 15 Minutes" reads mail, with settleMinutes
//     ("Game Days" only fires on game days anyway; if it ever did not, it stops).
// A run started any other way (by hand) reads mail with today's settings.

const cfg = __CONFIG__;
const nowMs = Date.now();
const tz = cfg.timezone;

function zoneParts(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}
// The UTC instant of a wall-clock time in the workflow's time zone.
function zonedToUtc(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (ms) => {
    const p = zoneParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  return guess - offset(guess - offset(guess));
}

// A weekend is open until the end of its Saturday (Eastern time).
const weekends = (cfg.weekends || []).map((w) => {
  const [y, m, d] = w.saturday.split('-').map(Number);
  const closesAt = new Date(zonedToUtc(y, m, d + 1, 0, 0)).toISOString();
  return { ...w, closesAt };
});
const openWeekends = weekends.filter((w) => nowMs < Date.parse(w.closesAt));
if (!openWeekends.length) {
  console.log('Config: no football weekend is open; nothing to do.');
  return [];
}

// Game days: the Wednesday (Friday minus 2) to the Saturday of each weekend.
const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const nowParts = zoneParts(nowMs);
const today = ymd(nowParts.year, nowParts.month, nowParts.day);
const gameDayWeekend = weekends.find((w) => {
  const [y, m, d] = w.friday.split('-').map(Number);
  return today >= ymd(y, m, d - 2) && today <= w.saturday;
});
const gameDay = Boolean(gameDayWeekend);

// Which trigger started this run: n8n says which trigger node ran; failing
// that, the trigger item's own minute (each trigger fires on different minutes).
const slots = (every, at) => {
  const out = [];
  for (let m = at || 0; m < 60; m += every) out.push(m);
  return out;
};
function startedBy() {
  for (const [node, kind] of [['Game Days', 'gameDays'], ['Every 15 Minutes', 'regular']]) {
    try {
      if ($(node).isExecuted === true) return kind;
    } catch (e) {
      // that node did not run (or is not in the workflow)
    }
  }
  const t = ($input.first() || {}).json || {};
  const ms = typeof t.timestamp === 'string' ? Date.parse(t.timestamp) : NaN;
  const minute = Number.isInteger(t.Minute) ? t.Minute : Number.isNaN(ms) ? null : zoneParts(ms).minute;
  if (minute === null) return 'manual';
  if (cfg.gameDays && slots(cfg.gameDays.pollMinutes, cfg.gameDays.atMinute).includes(minute)) return 'gameDays';
  if (slots(cfg.schedule.everyMinutes, cfg.schedule.atMinute).includes(minute)) return 'regular';
  return 'manual';
}
const trigger = startedBy();
if (gameDay && trigger === 'regular') {
  console.log(`Config: ${today} is a game day (${gameDayWeekend.name}); the ${cfg.gameDays.pollMinutes}-minute check reads mail, not this one.`);
  return [];
}
if (!gameDay && trigger === 'gameDays') {
  console.log(`Config: ${today} is not a game day; the regular check reads mail, not this one.`);
  return [];
}
const settleMinutes = gameDay ? cfg.gameDays.settleMinutes : cfg.settleMinutes;

const graphBase = `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`;
const sheetsBase = 'https://sheets.googleapis.com/v4/spreadsheets';
const a1 = (sheet, range) => `'${String(sheet).replace(/'/g, "''")}'!${range}`;
const valuesUrl = (id, range) =>
  `${sheetsBase}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;

const since = new Date(Math.max(Date.parse(cfg.processReceivedAfter) || 0, nowMs - cfg.lookbackHours * 3600 * 1000)).toISOString();
// The whole query lives in the URL so paging can follow @odata.nextLink as is.
const query = {
  $filter: `receivedDateTime ge ${since}`,
  $orderby: 'receivedDateTime asc',
  $top: '50',
  $select: 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,categories,bodyPreview,body,isDraft,replyTo',
};
const qs = Object.entries(query)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  .join('&');

const shared = {
  ...cfg,
  startedAt: new Date(nowMs).toISOString(),
  today,
  gameDay,
  trigger,
  settleMinutes,
  graphBase,
  since,
  weekends,
  openWeekends,
  requestsRange: a1(cfg.requestsSheet, 'A1:W'),
  requestsUrl: valuesUrl(cfg.spreadsheetId, a1(cfg.requestsSheet, 'A1:W')),
  crmUrl: valuesUrl(cfg.crm.spreadsheetId, a1(cfg.crm.sheet, cfg.crm.range)),
  batchUpdateUrl: `${sheetsBase}/${cfg.spreadsheetId}/values:batchUpdate`,
};

return ['inbox', 'sentitems'].map((folder) => ({
  json: { ...shared, folder, listUrl: `${graphBase}/mailFolders/${folder}/messages?${qs}` },
}));
