// Code node "Build Claude Request" (Run Once for Each Item).
// Input: the Read Requests response ({ values: [[header], [row 2], ...] }),
// read fresh for this message. Also uses the message (Loop Messages), its
// thread (Get Thread), the CRM (Load CRM) and the config.
// Output: the message, a compact view of the sheet, the addresses whose rows
// this message may change (ownerEmails, checked again in Plan Writes), and the
// Claude Messages API request body.

const cfg = $('Config').first().json;
const msg = $('Loop Messages').item.json;
const threadRes = $('Get Thread').item.json;
const crmValues = $('Load CRM').first().json.values || [];
const values = $json.values || [];
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();

const SYSTEM_PROMPT = __SYSTEM_PROMPT__;
const ACTIONS_SCHEMA = __ACTIONS_SCHEMA__;
const MAX_BODY_CHARS = 20000;
const MAX_THREAD_CHARS = 4000;
const THREAD_MESSAGES = 8;

const COLS = [
  'id', 'logged_at', 'weekend', 'first_name', 'last_name', 'email', 'number', 'member_category', 'accompanied',
  'experience', 'fare', 'covers', 'arrival_window', 'preference', 'dietary_restrictions', 'special_requests',
  'status', 'club_reply', 'requested_at', 'by_deadline', 'needs_check', 'evidence', 'version',
];

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function asText(type, content, max) {
  const t = String(type).toLowerCase() === 'html' ? htmlToText(content) : String(content || '').trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n[... cut: longer than ${max} characters]`;
}
function etText(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}
// Sheets dates come back as serial numbers (days since 1899-12-30, wall clock).
function serial(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d?):(\d\d)/);
  if (m) return (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - Date.UTC(1899, 11, 30)) / 86400000;
  const u = String(v || '').match(/^(\d\d?)\/(\d\d?)\/(\d{4})(?:\s+(\d\d?):(\d\d))?/);
  if (u) return (Date.UTC(+u[3], +u[1] - 1, +u[2], +(u[4] || 0), +(u[5] || 0)) - Date.UTC(1899, 11, 30)) / 86400000;
  return -Infinity;
}
const keyOf = (r) => [r.weekend, r.email, r.experience, r.fare].map((x) => String(x ?? '').trim().toLowerCase()).join('|');

// The sheet, as objects with their row numbers.
const rows = values.slice(1).map((v, i) => {
  const r = { row: i + 2 };
  COLS.forEach((c, j) => {
    r[c] = v[j] ?? '';
  });
  return r;
});
// Current = no later Logged-at row with the same weekend, email, experience and fare
// (what the sheet's Version formula says).
const latest = new Map();
for (const r of rows) latest.set(keyOf(r), Math.max(latest.get(keyOf(r)) ?? -Infinity, serial(r.logged_at)));
const openNames = cfg.openWeekends.map((w) => w.name);
const current = rows.filter((r) => r.id && openNames.includes(r.weekend) && serial(r.logged_at) >= latest.get(keyOf(r)));

const SHOWN = ['row', 'id', 'weekend', 'first_name', 'last_name', 'email', 'number', 'member_category', 'accompanied', 'experience', 'fare', 'covers', 'arrival_window', 'preference', 'dietary_restrictions', 'special_requests', 'status', 'club_reply', 'needs_check'];
const rowLines = current.map((r) => JSON.stringify(Object.fromEntries(SHOWN.filter((c) => r[c] !== '').map((c) => [c, r[c]]))));

// The thread: the messages in the conversation BEFORE this one, oldest first,
// the last few. Later replies are left out: they are handled on their own
// turn, and showing them here would apply their changes twice.
const msgAt = Date.parse(msg.receivedDateTime);
const when = (m) => Date.parse(m.receivedDateTime || m.sentDateTime);
const thread = (Array.isArray(threadRes.value) ? threadRes.value : [])
  .filter((m) => !m.isDraft && m.id !== msg.id && Number.isFinite(when(m)) && when(m) < msgAt)
  .sort((a, b) => when(a) - when(b))
  .slice(-THREAD_MESSAGES);

// The people in the message: who wrote and who it went to (not the Club).
const addrs = (list) => (list || []).map((r) => ({ address: String(r.emailAddress?.address || '').toLowerCase(), name: r.emailAddress?.name || '' }));
const people = [{ address: msg.from, name: msg.fromName }, ...addrs(msg.toRecipients), ...addrs(msg.ccRecipients)].filter(
  (p) => p.address && p.address !== mailbox,
);
const emails = new Set(people.map((p) => p.address));
const surnames = new Set(
  people
    .map((p) => String(p.name || '').replace(/[<(].*$/, '').trim())
    .filter((n) => n && !n.includes('@'))
    .map((n) => (n.includes(',') ? n.split(',')[0] : n.split(/\s+/).pop()).toLowerCase()),
);

// CRM candidates: matched by email, spouse email, surname, or a full name in the text.
const body = asText(msg.bodyType, msg.body, MAX_BODY_CHARS);
const haystack = `${msg.subject}\n${body}`.toLowerCase();
const header = (crmValues[0] || []).map((h) => String(h).trim().toLowerCase());
const col = (...names) => {
  for (const n of names) {
    const i = header.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
};
const C = {
  display: col('Display Name'), type: col('Type'), first: col('First Name'), last: col('Last Name'), allergens: col('Allergens'),
  email: col('Email'), phone: col('Phone'), spouseDisplay: col("Spouse's Display Name"), spouseFirst: col("Spouse's First Name"),
  spouseEmail: col("Spouse's Email"), spousePhone: col("Spouse's Phone"), spouseAllergens: col("Spouse's Allergens"),
};
const at = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
const category = (type) => {
  const t = type.toLowerCase();
  if (t.startsWith('gown')) return 'Gown';
  if (t.startsWith('town') || t.startsWith('honorary')) return 'Town';
  return '';
};
const candidates = [];
for (const row of crmValues.slice(1)) {
  const email = at(row, C.email).toLowerCase();
  const spouseEmail = at(row, C.spouseEmail).toLowerCase();
  const last = at(row, C.last);
  const first = at(row, C.first);
  const spouseFirst = at(row, C.spouseFirst);
  const why = [];
  if (email && emails.has(email)) why.push('email');
  if (spouseEmail && emails.has(spouseEmail)) why.push('spouse email');
  if (last && surnames.has(last.toLowerCase())) why.push('surname');
  if (last && first && haystack.includes(`${first} ${last}`.toLowerCase())) why.push('name in message');
  if (last && spouseFirst && haystack.includes(`${spouseFirst} ${last}`.toLowerCase())) why.push('spouse name in message');
  if (!why.length) continue;
  candidates.push({
    matched_by: why.join(', '),
    name: at(row, C.display) || `${first} ${last}`.trim(),
    first_name: first,
    last_name: last,
    type: at(row, C.type),
    category: category(at(row, C.type)),
    email: at(row, C.email),
    phone: at(row, C.phone),
    allergens: at(row, C.allergens),
    spouse_name: at(row, C.spouseDisplay) || spouseFirst,
    spouse_email: at(row, C.spouseEmail),
    spouse_phone: at(row, C.spousePhone),
    spouse_allergens: at(row, C.spouseAllergens),
  });
}
candidates.sort((a, b) => (/email/.test(b.matched_by) ? 1 : 0) - (/email/.test(a.matched_by) ? 1 : 0));
// Rows this message may change, cancel or update: the sender's own, and, when the
// sender is a CRM member (or spouse) by email, the member's and spouse's. Club
// messages are limited by kind instead (see Plan Writes).
const ownerEmails = [...new Set([
  msg.from,
  ...candidates
    .filter((c) => /(^|, )(email|spouse email)(,|$)/.test(c.matched_by))
    .flatMap((c) => [c.email, c.spouse_email]),
].map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))];
const crm = candidates.slice(0, 10).map((c) => JSON.stringify(Object.fromEntries(Object.entries(c).filter(([, v]) => v))));

// Email text is untrusted: escape it so it can't close its <message> tag and
// pass itself off as <rows>, <crm> or instructions.
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtPeople = (list) => addrs(list).map((p) => (p.name && p.name.toLowerCase() !== p.address ? `${p.name} <${p.address}>` : p.address)).join(', ');
const weekendLines = cfg.openWeekends.map((w) => {
  const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `- ${w.name}: Friday Supper on ${day(w.friday)}; Brunch and Saturday Supper on ${day(w.saturday)}. Requests were due by ${etText(Date.parse(w.deadline) - 60000)} ET.`;
});

const earlier = thread
  .map(
    (m) =>
      `<earlier_message from="${esc(m.from?.emailAddress?.address || '')}" sent="${etText(when(m))} ET">\n` +
      `${esc(asText(m.body?.contentType, m.body?.content || m.bodyPreview, MAX_THREAD_CHARS))}\n</earlier_message>`,
  )
  .join('\n\n');

const userContent = [
  msg.fromClub
    ? 'This is a message the Club sent from secretary@1892club.com (Sent Items). It can only update the Club Reply So Far or Needs a Check of an existing row, or log a request the Club is passing on.'
    : 'A message arrived at secretary@1892club.com.',
  '',
  `<message from="${esc(msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from)}" to="${esc(fmtPeople(msg.toRecipients))}" cc="${esc(fmtPeople(msg.ccRecipients))}" sent="${etText(msgAt)} ET">`,
  `Subject: ${esc(msg.subject)}`,
  '',
  esc(body),
  '</message>',
  '',
  earlier ? `Earlier messages in this thread, oldest first:\n\n${earlier}` : 'There are no earlier messages in this thread.',
  '',
  'Open football weekends:',
  ...weekendLines,
  '',
  `<rows note="the current row for each request on the open weekends; row is the sheet row number">`,
  rowLines.length ? rowLines.join('\n') : '(none yet)',
  '</rows>',
  '',
  '<crm note="CRM members who may match the people in this message; category is already mapped to Gown or Town">',
  crm.length ? crm.join('\n') : '(no matching member found)',
  '</crm>',
  '',
  `Now: ${etText(Date.now())} ET.`,
  'Return the sheet actions as JSON matching the schema.',
].join('\n');

return {
  json: {
    messageId: msg.id,
    currentRows: current.map((r) => r.row),
    crmCandidates: candidates.length,
    ownerEmails,
    request: {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      output_config: {
        effort: cfg.effort,
        format: { type: 'json_schema', schema: ACTIONS_SCHEMA },
      },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    },
  },
};
