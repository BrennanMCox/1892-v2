// Code node "Plan Writes" (Run Once for Each Item).
// Input: the Requests tab, read again right after Claude answered (so new IDs
// and new rows come from the sheet as it is now). Also uses Claude's answer
// (Ask Claude), the message (Loop Messages) and the addresses whose rows it may
// touch (Build Claude Request).
// Output: what to do with this message:
//   route "write": POST `body` to values:batchUpdate, then tag the email `tag`;
//   route "tag":   nothing to write (not football, or nothing changed); tag it;
//   route "fail":  Claude's answer can't be used safely; tag it for review.
// Only columns A-W are ever written. X-AD belong to the Secretary.

const cfg = $('Config').first().json;
const msg = $('Loop Messages').item.json;
const claude = $('Ask Claude').item.json;
const owners = new Set(($('Build Claude Request').item.json.ownerEmails || [msg.from]).map((a) => String(a || '').trim().toLowerCase()));
const values = $json.values || [];
const SHEET = cfg.requestsSheet;

const COLS = [
  'id', 'logged_at', 'weekend', 'first_name', 'last_name', 'email', 'number', 'member_category', 'accompanied',
  'experience', 'fare', 'covers', 'arrival_window', 'preference', 'dietary_restrictions', 'special_requests',
  'status', 'club_reply', 'requested_at', 'by_deadline', 'needs_check', 'evidence', 'version',
];
const LETTER = Object.fromEntries(COLS.map((c, i) => [c, String.fromCharCode(65 + i)])); // id -> A ... version -> W
const LAST_COLUMN = 'W';
const CLAUDE_FIELDS = [
  'weekend', 'first_name', 'last_name', 'email', 'number', 'member_category', 'accompanied', 'experience', 'fare',
  'covers', 'arrival_window', 'preference', 'dietary_restrictions', 'special_requests', 'club_reply', 'requested_at',
];
const ALLOWED = {
  member_category: ['Gown', 'Town'],
  accompanied: ['Yes', 'No'],
  experience: ['Friday Supper', 'Brunch', 'Saturday Supper'],
  fare: ['Full Fare', 'Light Fare'],
  arrival_window: [
    '10:00 a.m. to 11:00 a.m.', '11:00 a.m. to 12:00 p.m.', '12:00 p.m. to 1:00 p.m.', '1:00 p.m. to 2:00 p.m.',
    '5:00 p.m. to 7:30 p.m.', '7:30 p.m. to 9:00 p.m.', '9:00 p.m. to 10:30 p.m.',
  ],
  preference: ['Downstairs', 'Upstairs Bar & High-Tops', 'Upstairs Locker Room'],
};
const LABEL = {
  member_category: 'Member Category', accompanied: 'Accompanied', experience: 'Experience', fare: 'Fare',
  arrival_window: 'Arrival Window', preference: 'Preference', covers: 'Covers', weekend: 'Game Weekend',
};
// Free text is written with a leading apostrophe so Sheets keeps it as typed
// (never a formula, number or date).
const TEXT = new Set(['id', 'first_name', 'last_name', 'email', 'number', 'dietary_restrictions', 'special_requests', 'club_reply', 'needs_check', 'evidence']);

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
const pad = (n) => String(n).padStart(2, '0');
// "YYYY-MM-DD HH:MM" in Eastern time.
function etText(ms) {
  const p = zoneParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
function etToUtc(text) {
  const m = String(text).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (ms) => {
    const p = zoneParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  return guess - offset(guess - offset(guess));
}
// Sheets dates (UNFORMATTED_VALUE) are serial numbers: days since 1899-12-30, wall clock.
const EPOCH = Date.UTC(1899, 11, 30);
function serial(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d?):(\d\d)/);
  if (m) return (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - EPOCH) / 86400000;
  const u = String(v || '').match(/^(\d\d?)\/(\d\d?)\/(\d{4})(?:\s+(\d\d?):(\d\d))?/);
  if (u) return (Date.UTC(+u[3], +u[1] - 1, +u[2], +(u[4] || 0), +(u[5] || 0)) - EPOCH) / 86400000;
  return -Infinity;
}
const serialToText = (s) => {
  const d = new Date(Math.round(s * 1440) * 60000 + EPOCH);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const norm = (x) => String(x ?? '').trim().toLowerCase();
const keyOf = (r) => [r.weekend, r.email, r.experience, r.fare].map(norm).join('|');
const sheetName = `'${String(SHEET).replace(/'/g, "''")}'`;

function parseClaude(res) {
  if (!res || typeof res !== 'object') return { problem: 'no response from Claude' };
  if (res.error) return { problem: `Claude API error: ${String(res.error.message || JSON.stringify(res.error)).slice(0, 200)}` };
  if (res.stop_reason === 'refusal') return { problem: 'Claude declined (refusal)' };
  if (res.stop_reason === 'max_tokens') return { problem: "Claude's answer was cut off (max_tokens)" };
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.actions)) return { problem: 'answer has no actions list' };
    return { decision: d };
  } catch (err) {
    return { problem: `could not read Claude's JSON: ${err.message}` };
  }
}

const out = (route, extra) => ({
  json: {
    route,
    messageId: msg.id,
    knownCategories: msg.categories || [],
    tag: route === 'fail' ? cfg.categories.failed : extra.tag,
    ...extra,
  },
});
const fail = (problem, extra = {}) => out('fail', { problem, body: null, ...extra });

const parsed = parseClaude(claude);
if (parsed.problem) return fail(parsed.problem);
const decision = parsed.decision;

// The sheet as it is now.
const rows = values.slice(1).map((v, i) => {
  const r = { row: i + 2 };
  COLS.forEach((c, j) => {
    r[c] = v[j] ?? '';
  });
  return r;
});
const byRow = new Map(rows.map((r) => [r.row, r]));
const latest = new Map();
for (const r of rows) latest.set(keyOf(r), Math.max(latest.get(keyOf(r)) ?? -Infinity, serial(r.logged_at)));
const isCurrent = (r) => serial(r.logged_at) >= latest.get(keyOf(r));
const weekendByName = new Map(cfg.weekends.map((w) => [w.name, w]));
const openNames = new Set(cfg.openWeekends.map((w) => w.name));
const maxNumber = {};
for (const r of rows) {
  const m = String(r.id).match(/^([A-Z]+)-(\d+)$/);
  if (m) maxNumber[m[1]] = Math.max(maxNumber[m[1]] || 0, Number(m[2]));
}
const nextId = (prefix) => {
  maxNumber[prefix] = (maxNumber[prefix] || 0) + 1;
  return `${prefix}-${String(maxNumber[prefix]).padStart(3, '0')}`;
};
// New rows go just below the last row with a Request ID. (A hand-kept sheet
// often has the Version formula or formatting filled down past the data, so
// the length of the read is not the end of the data.)
const lastIdRow = rows.reduce((m, r) => (String(r.id).trim() ? Math.max(m, r.row) : m), 1);
let nextRow = lastIdRow + 1;
const rowIsFree = (n) => (values[n - 1] || []).slice(0, COLS.length - 1).every((v) => String(v ?? '').trim() === '');

const nowMs = Date.now();
const loggedText = etText(nowMs);
const today = loggedText.slice(0, 10);
const appendNote = (existing, note) => (String(existing || '').trim() ? `${String(existing).trim()}; ${note}` : note);

// Enum checks: a value that isn't on the list is left blank, with a note in U.
function clean(fields, notes) {
  const f = { ...fields };
  for (const [k, list] of Object.entries(ALLOWED)) {
    const v = String(f[k] ?? '').trim();
    if (!v) {
      f[k] = '';
      continue;
    }
    const hit = list.find((x) => norm(x) === norm(v));
    if (hit) f[k] = hit;
    else {
      notes.push(`${LABEL[k]} "${v}" is not an allowed value; left blank`);
      f[k] = '';
    }
  }
  if (f.fare && f.experience !== 'Saturday Supper') {
    notes.push(`Fare "${f.fare}" given for ${f.experience || 'an unknown experience'}; left blank`);
    f.fare = '';
  }
  const covers = String(f.covers ?? '').trim();
  if (covers && !/^\d{1,3}$/.test(covers)) {
    notes.push(`Covers "${covers}" is not a whole number; left blank`);
    f.covers = '';
  } else f.covers = covers ? Number(covers) : '';
  return f;
}

function resolveTarget(a) {
  let r = byRow.get(Number(a.target_row));
  if (a.target_id && (!r || r.id !== a.target_id)) r = rows.find((x) => x.id === a.target_id);
  if (!r || !r.id) return { problem: `${a.kind}: row ${a.target_row} (${a.target_id || 'no id'}) is not in the sheet` };
  if (!openNames.has(r.weekend)) return { problem: `${a.kind}: ${r.id} is not on an open weekend` };
  // A member's message may only touch that member's (or spouse's) rows.
  if (!msg.fromClub && !owners.has(norm(r.email))) {
    return { problem: `${a.kind}: ${r.id} belongs to ${r.email || 'no email'}, not to the sender ${msg.from}` };
  }
  // Always act on the current row of that request.
  if (!isCurrent(r)) {
    const cur = rows.filter((x) => keyOf(x) === keyOf(r) && isCurrent(x)).pop();
    if (cur) r = cur;
  }
  return { r };
}

const cellUpdates = new Map(); // row -> { status?, club_reply?, needs_check? }
const touch = (r, field, value) => {
  if (!cellUpdates.has(r.row)) cellUpdates.set(r.row, {});
  cellUpdates.get(r.row)[field] = value;
  r[field] = value;
};
const newRows = [];
const problems = [];
const log = [];

function addRow(f, a, notes) {
  const w = weekendByName.get(f.weekend);
  // Logged-at must be later than every other row of the same request, or the
  // Version formula can't tell which one is current.
  let logged = serial(loggedText);
  const prior = latest.get(keyOf(f));
  if (prior !== undefined && prior >= logged) logged = prior + 1 / 1440;
  // Requested At is when the member wrote: this message, unless Claude saw the
  // request was made at another time.
  const given = String(a.fields?.requested_at || '').trim();
  const override = /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(given) && Number.isFinite(etToUtc(given));
  const requestedMs = override ? etToUtc(given) : Date.parse(msg.receivedDateTime);
  const requestedText = etText(requestedMs);
  const row = {
    ...f,
    id: nextId(w.prefix),
    logged_at: serialToText(logged),
    status: 'Active',
    requested_at: requestedText,
    by_deadline: requestedMs <= Date.parse(w.deadline) ? 'Yes' : 'No',
    needs_check: notes.filter(Boolean).join('; '),
    evidence: String(a.evidence || '').trim(),
    row: nextRow,
  };
  nextRow += 1;
  latest.set(keyOf(row), Math.max(latest.get(keyOf(row)) ?? -Infinity, logged));
  newRows.push(row);
  return row;
}

for (const a of decision.actions) {
  const fields = Object.fromEntries(CLAUDE_FIELDS.map((k) => [k, String(a.fields?.[k] ?? '').trim()]));
  const notes = [];
  if (a.kind === 'not_football') {
    log.push('not football');
    continue;
  }
  if (a.kind === 'new_row') {
    const f = clean(fields, notes);
    if (!weekendByName.has(f.weekend) || !openNames.has(f.weekend)) {
      problems.push(`new_row: weekend "${f.weekend}" is not an open football weekend`);
      continue;
    }
    if (!f.email && !msg.fromClub) f.email = msg.from;
    if (!f.club_reply) f.club_reply = 'No reply';
    const row = addRow(f, a, [String(a.needs_check || '').trim(), ...notes]);
    log.push(`new ${row.id} at row ${row.row}`);
    continue;
  }
  if (!['change_row', 'cancel_row', 'update_in_place'].includes(a.kind)) {
    problems.push(`unknown action "${a.kind}"`);
    continue;
  }
  // A Club message (Sent Items) only updates Club Reply So Far / Needs a Check.
  if (msg.fromClub && a.kind !== 'update_in_place') {
    problems.push(`${a.kind} from a Club message (Sent Items); only update_in_place or new_row is allowed`);
    continue;
  }
  const t = resolveTarget(a);
  if (t.problem) {
    problems.push(t.problem);
    continue;
  }
  const old = t.r;

  if (a.kind === 'change_row') {
    const merged = {};
    for (const k of CLAUDE_FIELDS) {
      if (k === 'requested_at') continue;
      merged[k] = fields[k] !== '' ? fields[k] : old[k];
    }
    for (const k of a.clear_fields || []) if (k in merged) merged[k] = '';
    // A fare carried forward from a Saturday Supper means nothing for another
    // experience: drop it quietly (only a fare Claude gave is worth a note).
    if (!fields.fare && norm(merged.experience) !== norm('Saturday Supper')) merged.fare = '';
    const f = clean(merged, notes);
    if (!weekendByName.has(f.weekend) || !openNames.has(f.weekend)) {
      problems.push(`change_row: weekend "${f.weekend}" is not an open football weekend`);
      continue;
    }
    const check = String(a.needs_check || '').trim();
    const carried = a.needs_check_mode === 'replace' ? '' : String(old.needs_check || '').trim();
    const row = addRow(f, a, [carried, check, ...notes]);
    if (keyOf(row) !== keyOf(old)) {
      touch(old, 'status', 'Cancelled');
      touch(old, 'needs_check', appendNote(old.needs_check, `Replaced by ${row.id}`));
    }
    log.push(`change ${old.id} -> ${row.id} at row ${row.row}`);
    continue;
  }

  if (a.kind === 'cancel_row') {
    touch(old, 'status', 'Cancelled');
    const extra = String(a.needs_check || '').trim();
    touch(old, 'needs_check', appendNote(old.needs_check, `${today}: Cancelled by the member${extra ? ` (${extra})` : ''}`));
    log.push(`cancel ${old.id}`);
    continue;
  }

  // update_in_place: only Club Reply So Far and Needs a Check.
  if (fields.club_reply) touch(old, 'club_reply', fields.club_reply);
  const check = String(a.needs_check || '').trim();
  if (a.needs_check_mode === 'replace') touch(old, 'needs_check', check);
  else if (check) touch(old, 'needs_check', appendNote(old.needs_check, `${today}: ${check}`));
  log.push(`update ${old.id}`);
}

for (const r of newRows) {
  if (!rowIsFree(r.row)) problems.push(`row ${r.row}, below the last Request ID, already has something in A-V; not writing over it`);
}
if (problems.length) return fail(problems.join('; '), { summary: decision.summary || '', log });

const cell = (field, value) => {
  if (value === '' || value === null || value === undefined) return '';
  if (TEXT.has(field)) return `'${String(value)}`;
  return value;
};
const versionFormula = (n) =>
  `=IF(COUNTIFS(${['C', 'F', 'J', 'K'].map((c) => `$${c}:$${c},IF($${c}${n}="","=",$${c}${n})`).join(',')},$B:$B,">"&$B${n})=0,"Current","Superseded")`;

const data = [];
for (const r of newRows) {
  const vals = COLS.map((c) => (c === 'version' ? versionFormula(r.row) : cell(c, r[c])));
  data.push({ range: `${sheetName}!A${r.row}:${LAST_COLUMN}${r.row}`, values: [vals] });
}
for (const [row, upd] of [...cellUpdates.entries()].sort((x, y) => x[0] - y[0])) {
  for (const field of ['status', 'club_reply', 'needs_check']) {
    if (field in upd) data.push({ range: `${sheetName}!${LETTER[field]}${row}`, values: [[cell(field, upd[field])]] });
  }
}

// Belt and braces: nothing outside A-W, ever.
for (const d of data) {
  const cols = d.range.split('!')[1].replace(/\d+/g, '').split(':');
  if (!cols.every((c) => /^[A-W]$/.test(c))) return fail(`refusing to write outside A-W: ${d.range}`);
}

const onlyNotFootball = decision.actions.length > 0 && decision.actions.every((a) => a.kind === 'not_football');
const tag = onlyNotFootball ? cfg.categories.ignored : cfg.categories.done;
const result = { tag, summary: decision.summary || '', log, newIds: newRows.map((r) => r.id) };
if (!data.length) return out('tag', { ...result, body: null });
return out('write', { ...result, body: { valueInputOption: 'USER_ENTERED', data } });
