// Code node "Chef Config" (Run Once for All Items).
// Runs on the Wednesday-morning trigger. Output: one item naming the weekend
// whose Friday is two days from today (Eastern time), or nothing (the run
// stops) when there is no such weekend or the chef report is turned off.

const cfg = __CONFIG__;
const report = cfg.chefReport || {};
if (!report.enabled) return [];

const p = Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now()))
    .map((x) => [x.type, x.value]),
);
const today = `${p.year}-${p.month}-${p.day}`;
const inTwoDays = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 2)).toISOString().slice(0, 10);
const weekend = (cfg.weekends || []).find((w) => w.friday === inTwoDays);
if (!weekend) {
  console.log(`Chef Config: no football weekend starts on ${inTwoDays}; no report.`);
  return [];
}

const sheet = `'${String(cfg.requestsSheet).replace(/'/g, "''")}'!A1:W`;
return [
  {
    json: {
      ...cfg,
      today,
      weekend,
      graphBase: `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`,
      requestsUrl: `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values/${encodeURIComponent(sheet)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    },
  },
];
