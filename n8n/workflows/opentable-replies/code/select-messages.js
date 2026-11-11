// Code node "Select Messages" (Run Once for All Items).
// Input: the List Inbox pages (Graph { value: [message, ...] }).
// Output: one item per message to handle, oldest first, at most maxPerRun.
// Dropped here, untouched (no tag):
//   - drafts, and anything received before processReceivedAfter / the lookback;
//   - anything already carrying one of this workflow's four categories
//     (Replied, No Reply, Needs Review, Sending: a "Sending" message is never
//     retried, so a crash can never send a second email);
//   - mail younger than settleMinutes (a quick follow-up can land first), or
//     that the Secretary Inbox workflow is still working on: these wait for a
//     later check.
// Kept with a skipReason (never answered; tagged "OpenTable: No Reply"):
//   - mail with no sender address;
//   - mail from the mailbox itself or from a staff domain (From or Reply-To);
//   - automated mail: no-reply and system senders (OpenTable and the like),
//     newsletters and mailing lists, bounces, out-of-office replies, meeting
//     invitations and responses.

const cfg = $('Config').first().json;
const C = cfg.categories;
const OURS = [C.replied, C.skipped, C.failed, C.sending];
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();
const now = Date.now();
const cutoff = Math.max(Date.parse(cfg.processReceivedAfter) || 0, now - cfg.lookbackHours * 3600 * 1000);
const automated = (cfg.automatedSenders || []).map((s) => new RegExp(s, 'i'));
const staff = (cfg.staffDomains || []).map((d) => String(d).toLowerCase());
const waitWhile = cfg.waitWhileCategories || [];

const addr = (r) => String(r?.emailAddress?.address || '').trim().toLowerCase();
const isStaff = (a) => {
  const domain = a.split('@')[1] || '';
  return staff.some((d) => domain === d || domain.endsWith(`.${d}`));
};

function headerMap(m) {
  const out = {};
  for (const h of m.internetMessageHeaders || []) out[String(h.name || '').toLowerCase()] = String(h.value || '');
  return out;
}

function automatedReason(m, from) {
  if (/eventMessage|calendarSharingMessage/i.test(String(m['@odata.type'] || ''))) return 'meeting invitation';
  const subject = String(m.subject || '').trim();
  if (/^(undeliverable|undelivered|delivery status notification|delivery has failed|mail delivery failed|returned mail|automatic reply|auto(matic)?[- ]?reply|out of (the )?office|accepted|declined|tentative|new time proposed|invitation|updated invitation|canceled|cancelled event)\b/i.test(subject)) {
    return 'bounce, auto-reply or meeting response';
  }
  if (automated.some((re) => re.test(from))) return `system sender ${from}`;
  const h = headerMap(m);
  if (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'].trim())) return 'auto-submitted';
  if (/^(bulk|list|junk|auto_reply)$/i.test((h.precedence || '').trim())) return 'bulk or list mail';
  if (h['list-unsubscribe'] || h['list-id']) return 'mailing list';
  if (h['x-autoreply'] || h['x-autorespond']) return 'auto-reply';
  return '';
}

const messages = $input.all().flatMap((i) => i.json.value || []);
const seen = new Set();
const keep = [];
for (const m of messages) {
  if (!m || !m.id || seen.has(m.id)) continue;
  seen.add(m.id);
  const received = Date.parse(m.receivedDateTime);
  if (!(received >= cutoff)) continue;
  if (m.isDraft) continue;
  const cats = m.categories || [];
  if (cats.some((c) => OURS.includes(c))) continue;
  if (cats.some((c) => waitWhile.some((p) => String(c).startsWith(p)))) continue;
  if (now - received < (cfg.settleMinutes || 0) * 60000) continue;
  const from = addr(m.from);
  const replyTo = (m.replyTo || []).map(addr).filter(Boolean);
  let skipReason = '';
  if (!from || !from.includes('@')) skipReason = 'no sender address';
  else if (from === mailbox || replyTo.includes(mailbox)) skipReason = 'from the mailbox itself';
  else if (isStaff(from) || replyTo.some(isStaff)) skipReason = 'from staff';
  else skipReason = automatedReason(m, from) || (replyTo.some((a) => automated.some((re) => re.test(a))) ? 'automated Reply-To' : '');
  keep.push({ m, from, replyTo, received, skipReason });
}

keep.sort((a, b) => a.received - b.received);
if (keep.length > cfg.maxPerRun) {
  console.log(`Select Messages: ${keep.length - cfg.maxPerRun} message(s) left for the next run (maxPerRun=${cfg.maxPerRun}).`);
}

return keep.slice(0, cfg.maxPerRun).map(({ m, from, replyTo, skipReason }) => ({
  json: {
    id: m.id,
    conversationId: m.conversationId || '',
    subject: m.subject || '',
    from,
    fromName: m.from?.emailAddress?.name || '',
    replyTo,
    toRecipients: m.toRecipients || [],
    ccRecipients: m.ccRecipients || [],
    receivedDateTime: m.receivedDateTime,
    sentDateTime: m.sentDateTime || m.receivedDateTime,
    categories: m.categories || [],
    bodyType: m.body?.contentType || 'text',
    body: m.body?.content || '',
    ...(skipReason ? { skipReason } : {}),
  },
}));
