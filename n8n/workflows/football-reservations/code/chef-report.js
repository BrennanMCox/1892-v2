// Code node "Build Chef Report" (Run Once for All Items).
// Input: the Requests tab ({ values }). Output: the chef's covers email for the
// weekend Chef Config chose, as a Graph message body (`draft`), and whether to
// send it (`send`, only when chefReport.mode is "send").
// Counts only rows that are Active and Current (no later Logged-at row with the
// same weekend, email, experience and fare), like the Chef Summary tab.

const cfg = $('Chef Config').first().json;
const W = cfg.weekend;
const values = $input.first().json.values || [];

const COLS = [
  'id', 'logged_at', 'weekend', 'first_name', 'last_name', 'email', 'number', 'member_category', 'accompanied',
  'experience', 'fare', 'covers', 'arrival_window', 'preference', 'dietary_restrictions', 'special_requests',
  'status', 'club_reply', 'requested_at', 'by_deadline', 'needs_check', 'evidence', 'version',
];
const EPOCH = Date.UTC(1899, 11, 30);
function serial(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d?):(\d\d)/);
  if (m) return (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - EPOCH) / 86400000;
  const u = String(v || '').match(/^(\d\d?)\/(\d\d?)\/(\d{4})(?:\s+(\d\d?):(\d\d))?/);
  if (u) return (Date.UTC(+u[3], +u[1] - 1, +u[2], +(u[4] || 0), +(u[5] || 0)) - EPOCH) / 86400000;
  return -Infinity;
}
const norm = (x) => String(x ?? '').trim().toLowerCase();
const keyOf = (r) => [r.weekend, r.email, r.experience, r.fare].map(norm).join('|');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const rows = values.slice(1).map((v, i) => {
  const r = { row: i + 2 };
  COLS.forEach((c, j) => {
    r[c] = v[j] ?? '';
  });
  return r;
});
const latest = new Map();
for (const r of rows) latest.set(keyOf(r), Math.max(latest.get(keyOf(r)) ?? -Infinity, serial(r.logged_at)));
const live = rows.filter(
  (r) => r.id && r.weekend === W.name && norm(r.status) === 'active' && serial(r.logged_at) >= latest.get(keyOf(r)),
);

const coversOf = (r) => (Number.isFinite(Number(r.covers)) && String(r.covers).trim() !== '' ? Number(r.covers) : null);
const LINES = [
  { label: 'Friday Supper', test: (r) => r.experience === 'Friday Supper' },
  { label: 'Brunch', test: (r) => r.experience === 'Brunch' },
  { label: 'Saturday Supper, Full Fare', test: (r) => r.experience === 'Saturday Supper' && r.fare === 'Full Fare' },
  { label: 'Saturday Supper, Light Fare', test: (r) => r.experience === 'Saturday Supper' && r.fare === 'Light Fare' },
  { label: 'Saturday Supper, Fare Unclear', test: (r) => r.experience === 'Saturday Supper' && !r.fare },
];
const totals = LINES.map((l) => {
  const list = live.filter(l.test);
  return {
    label: l.label,
    parties: list.length,
    covers: list.reduce((s, r) => s + (coversOf(r) || 0), 0),
    unknownCovers: list.filter((r) => coversOf(r) === null).length,
  };
});
const name = (r) => `${r.first_name} ${r.last_name}`.trim() || r.email;
const expOf = (r) => [r.experience, r.fare].filter(Boolean).join(', ');
const dietary = live.filter((r) => String(r.dietary_restrictions).trim());
// What the Club still has to get from the member before the Chef can count it.
const missingOf = (r) =>
  [
    !r.experience && 'Experience',
    coversOf(r) === null && 'Covers',
    r.experience === 'Saturday Supper' && !r.fare && 'Fare (Full or Light)',
  ].filter(Boolean);
const incomplete = live.filter((r) => missingOf(r).length);
const late = live.filter((r) => r.by_deadline === 'No');

const table = (head, body) =>
  `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse"><tr>${head.map((h) => `<th align="left">${esc(h)}</th>`).join('')}</tr>` +
  body.map((cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') +
  '</table>';
const section = (title, list, head, cells) => `<h3>${esc(title)}</h3>` + (list.length ? table(head, list.map(cells)) : '<p>None.</p>');
const sheetUrl = `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}`;

const html =
  `<p>Good morning, Chef Allen,</p><p>For ${esc(W.name)} Weekend, here are the requested covers: <a href="${esc(sheetUrl)}">1892 Football Weekend Reservations</a>. To be sure, these requests have neither been confirmed nor inputted into OpenTable.</p>` +
  table(
    ['Experience', 'Members', 'Covers', 'Parties without covers'],
    [...totals.map((t) => [t.label, t.parties, t.covers, t.unknownCovers]), ['Total', totals.reduce((s, t) => s + t.parties, 0), totals.reduce((s, t) => s + t.covers, 0), totals.reduce((s, t) => s + t.unknownCovers, 0)]],
  ) +
  section('Dietary restrictions', dietary, ['Request', 'Member', 'Experience', 'Covers', 'Restrictions'], (r) => [r.id, name(r), expOf(r), r.covers, r.dietary_restrictions]) +
  section('Requests without Experience, Covers, or Fare', incomplete, ['Request', 'Name', 'Experience', 'Covers', 'Needs a check'], (r) => [r.id, name(r), expOf(r) || '(not given)', r.covers === '' ? '(not given)' : r.covers, `Needs to confirm: ${missingOf(r).join(', ')}`]) +
  section('Requested after Midnight', late, ['Request', 'Name', 'Experience', 'Covers'], (r) => [r.id, name(r), expOf(r), r.covers]) +
  '<p>Sincerely,<br>/claude</p>';

const recipients = (list) => (list || []).map((address) => ({ emailAddress: { address } }));
return [
  {
    json: {
      weekend: W.name,
      totals,
      dietary: dietary.map((r) => r.id),
      incomplete: incomplete.map((r) => r.id),
      late: late.map((r) => r.id),
      send: cfg.chefReport.mode === 'send',
      draft: {
        subject: `Requested Covers, ${W.name} Weekend`,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients(cfg.chefReport.to),
        ccRecipients: recipients(cfg.chefReport.cc),
      },
    },
  },
];
