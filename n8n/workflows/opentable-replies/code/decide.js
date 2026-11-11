// Code node "Decide" (Run Once for Each Item).
// Input: Claude's answer (Ask Claude). Also uses the message (Loop Messages,
// already matched to the CRM) and the config.
// Output: what to do with this message:
//   route "reply": send the fixed OpenTable note (html) to replyAddress only;
//   route "skip":  no reply; tag it "OpenTable: No Reply";
//   route "fail":  Claude's answer can't be used; tag it "OpenTable: Needs Review".
// Claude only describes the email. The rules here decide, and the reply text is
// a fixed template: Claude never writes a word of it.

const cfg = $('Config').first().json;
const msg = $('Loop Messages').item.json;
const res = $json;
const C = cfg.categories;
const max = cfg.maxPartySize;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The reply, as plain-text paragraphs. Links are the URLs themselves.
function replyParagraphs(firstName) {
  return [
    [firstName ? `Hello ${firstName},` : 'Hello,'],
    ['We look forward to hosting you!'],
    [`For groups of ${NUMBER_WORDS[max]} or fewer, OpenTable is the quickest way to book reservations at the Club:`],
    ['Book Upstairs:', { link: cfg.links.upstairs }],
    ['Book Downstairs:', { link: cfg.links.downstairs }],
    [`If your group is ${NUMBER_WORDS[max + 1]} or larger, reply back "LARGE GROUP" and we will take it from there.`],
    ['Sincerely,', '/claude'],
  ];
}
const replyText = (firstName) =>
  replyParagraphs(firstName)
    .map((p) => p.map((l) => (typeof l === 'string' ? l : l.link)).join('\n'))
    .join('\n\n');
const replyHtml = (firstName) =>
  replyParagraphs(firstName)
    .map((p) => `<p>${p.map((l) => (typeof l === 'string' ? escHtml(l) : `<a href="${escHtml(l.link)}">${escHtml(l.link)}</a>`)).join('<br>')}</p>`)
    .join('\n');

const out = (route, reason, extra = {}) => ({
  json: {
    route,
    reason,
    messageId: msg.id,
    tag: route === 'reply' ? C.replied : route === 'fail' ? C.failed : C.skipped,
    ...extra,
  },
});

function parseClaude(r) {
  if (!r || typeof r !== 'object') return { problem: 'no response from Claude' };
  if (r.error) return { problem: `Claude API error: ${String(r.error.message || JSON.stringify(r.error)).slice(0, 200)}` };
  if (r.stop_reason === 'refusal') return { problem: 'Claude declined (refusal)' };
  if (r.stop_reason === 'max_tokens') return { problem: "Claude's answer was cut off (max_tokens)" };
  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object' || typeof d.is_new_booking_request !== 'boolean' || !Array.isArray(d.requested_dates) || typeof d.football_weekend !== 'boolean') {
      return { problem: "Claude's answer does not match the schema" };
    }
    return { decision: d };
  } catch (err) {
    return { problem: `could not read Claude's JSON: ${err.message}` };
  }
}

const parsed = parseClaude(res);
if (parsed.problem) return out('fail', parsed.problem);
const d = parsed.decision;
const said = String(d.reason || '').slice(0, 300);

// Eastern date (YYYY-MM-DD) of a moment.
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const footballDates = new Set((cfg.footballWeekends || []).flatMap((w) => [w.friday, w.saturday]));
const footballNames = (cfg.footballWeekends || []).map((w) => String(w.name).toLowerCase());
const plain = `${msg.subject || ''}\n${String(msg.body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')}`.toLowerCase();
const mentionsFootball =
  /\b(football|game\s?day|home game|the game|kick-?off|tailgat\w*|mizzou)\b/i.test(plain) || footballNames.some((n) => n && plain.includes(n));

if (!msg.member || !msg.replyAddress) return out('skip', msg.skipReason || 'not a member');
if (d.is_new_booking_request !== true) return out('skip', `not a new table request: ${said}`);
if (!(Number.isInteger(d.party_size) && d.party_size >= 1 && d.party_size <= max)) {
  return out('skip', d.party_size == null ? 'party size unknown' : `party size ${d.party_size} is not 1-${max}`);
}
if (d.football_weekend) return out('skip', `football weekend: ${said}`);
const dates = d.requested_dates.map((x) => String(x).trim());
const sentDay = etDate(Date.parse(msg.sentDateTime || msg.receivedDateTime));
for (const x of dates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(`${x}T12:00:00Z`))) return out('skip', `unreadable date "${x}"`);
  if (footballDates.has(x)) return out('skip', `${x} is a football weekend date`);
  if (x < sentDay) return out('skip', `${x} is before the email was sent`);
}
if (!dates.length && mentionsFootball) return out('skip', 'no date given and the email mentions a football weekend or game');

// Claude's dates are checked against the words of the email itself (the new
// text only, not a quoted earlier message): a day the email names but Claude
// left unresolved, or resolved to the wrong weekday, means no reply.
const fresh = plain.split(/\n\s*(?:-{2,}\s*original message|from:\s|sent:\s|on [^\n]{0,200}wrote:|>)/i)[0];
const WEEKDAYS = [
  /\b(sunday|sun\.)/i,
  /\b(monday|mon\.?)\b/i,
  /\b(tuesday|tues?\.?)\b/i,
  /\b(wednesday|wed\.)/i,
  /\b(thursday|thurs?\.?|thu\.?)\b/i,
  /\b(friday|fri\.?)\b/i,
  /\b(saturday|sat\.)/i,
];
const namedDays = WEEKDAYS.map((re, i) => (re.test(fresh) ? i : -1)).filter((i) => i >= 0);
const relative = /\b(today|tonight|tomorrow|weekend|next week|this week)\b/i.test(fresh);
const calendarDate =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b/i.test(fresh) ||
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(fresh) ||
  /\b\d{1,2}(st|nd|rd|th)\b/i.test(fresh);
if (!dates.length && (namedDays.length || relative || calendarDate)) return out('skip', 'the email names a day Claude did not resolve to a date');
const weekdayOf = (x) => new Date(`${x}T12:00:00Z`).getUTCDay();
for (const day of namedDays) {
  if (!dates.some((x) => weekdayOf(x) === day)) return out('skip', `the email names a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]} but no requested date falls on one`);
}

return out('reply', said || 'table request', {
  partySize: d.party_size,
  requestedDates: dates,
  replyAddress: msg.replyAddress,
  // "Re: <original subject>" (kept as is when it already starts with Re:).
  subject: /^\s*re:/i.test(String(msg.subject || '')) ? String(msg.subject).trim() : `Re: ${String(msg.subject || '').trim()}`.trim(),
  firstName: msg.firstName || '',
  text: replyText(msg.firstName || ''),
  html: replyHtml(msg.firstName || ''),
});
