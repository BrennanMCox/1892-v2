// Code node "Select Messages" (Run Once for All Items).
// Input: the List Mail pages (Graph { value: [message, ...] }) for the Inbox and
// Sent Items. Output: one item per message to read, oldest first, at most
// maxPerRun. Dropped here, untouched:
//   - anything already tagged with one of this workflow's three categories;
//   - anything received before processReceivedAfter or the lookback window;
//   - automated mail (no-reply, newsletters, OpenTable and other system senders,
//     bounces, out-of-office replies, meeting invitations);
//   - Inbox mail the Secretary Inbox workflow is still working on, or that
//     arrived less than settleMinutes ago (so its tags and ours never cross);
//   - this workflow's own chef report, once sent (it sits in Sent Items);
//   - this workflow's own acknowledgements, once sent (Sent Items): a message
//     from the mailbox whose text STARTS with the acknowledgement (a later
//     Club reply that only quotes it is still read).
// The "Reservations: Acknowledging" / "Acknowledged" tags play no part here: a
// message that has them also has Logged or Needs Review.
// Each message also carries its folder ("inbox" or "sentitems", from the page's
// @odata.context or the Config item List Mail paired it with; "" if neither) and its Reply-To addresses, for the
// acknowledgement (Plan Acknowledgement).

const cfg = $('Config').first().json;
const C = cfg.categories;
const OURS = [C.done, C.ignored, C.failed];
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();
const now = Date.now();
const cutoff = Math.max(Date.parse(cfg.processReceivedAfter) || 0, now - cfg.lookbackHours * 3600 * 1000);
const automated = (cfg.automatedSenders || []).map((s) => new RegExp(s, 'i'));
const inProgress = cfg.secretaryInProgressCategories || [];
const chefPeople = new Set([...(cfg.chefReport?.to || []), ...(cfg.chefReport?.cc || [])].map((a) => String(a).toLowerCase()));
function isChefReport(m) {
  if (/^Requested Covers, .+ Weekend$| covers for the Chef$/i.test(String(m.subject || '').trim())) return true;
  const to = [...(m.toRecipients || []), ...(m.ccRecipients || [])].map((r) => String(r.emailAddress?.address || '').toLowerCase());
  return to.length > 0 && to.every((a) => chefPeople.has(a));
}

const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const ack = cfg.acknowledgement || {};
const ackOpening = squash(String(ack.greeting || '').split('{name}')[0]);
const ackFirst = squash(String((ack.paragraphs || [])[0] || '').split('{phone}').join(ack.phone || ''));
function isOwnAcknowledgement(m) {
  if (!ackOpening || !ackFirst) return false;
  const text = squash(m.body?.content || m.bodyPreview || '');
  return text.startsWith(ackOpening) && text.slice(0, 120 + ackFirst.length).includes(ackFirst);
}

function automatedReason(m, from) {
  if (!from) return 'no sender';
  if (/eventMessage|calendarSharingMessage/i.test(String(m['@odata.type'] || ''))) return 'meeting invitation';
  const subject = String(m.subject || '');
  if (/^(undeliverable|delivery status notification|mail delivery failed|automatic reply|auto(matic)?[- ]reply|out of (the )?office)\b/i.test(subject)) {
    return 'bounce or auto-reply';
  }
  if (automated.some((re) => re.test(from))) return `system sender ${from}`;
  return '';
}

// The folder a page of List Mail came from: as Graph names it in @odata.context,
// else the folder of the Config item that List Mail paired the page with.
// '' when neither says (Plan Acknowledgement then never acknowledges it).
const FOLDERS = ['inbox', 'sentitems'];
const folderOf = (page, index) => {
  const ctx = String(page['@odata.context'] || '');
  if (/mailFolders\('sentitems'\)/i.test(ctx)) return 'sentitems';
  if (/mailFolders\('inbox'\)/i.test(ctx)) return 'inbox';
  try {
    const paired = String($('Config').itemMatching(index)?.json?.folder || '').toLowerCase();
    return FOLDERS.includes(paired) ? paired : '';
  } catch (e) {
    return '';
  }
};
const messages = $input.all().flatMap((i, index) => (i.json.value || []).map((m) => (m ? { ...m, folder: folderOf(i.json, index) } : m)));
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
  const from = String(m.from?.emailAddress?.address || '').toLowerCase();
  const fromClub = Boolean(mailbox) && from === mailbox;
  if (fromClub && (isChefReport(m) || isOwnAcknowledgement(m))) continue;
  if (!fromClub) {
    if (automatedReason(m, from)) continue;
    if (cats.some((c) => inProgress.some((p) => String(c).startsWith(p)))) continue;
    if (now - received < (cfg.settleMinutes || 0) * 60000) continue;
  }
  keep.push({ m, from, fromClub, received });
}

keep.sort((a, b) => a.received - b.received);
if (keep.length > cfg.maxPerRun) {
  console.log(`Select Messages: ${keep.length - cfg.maxPerRun} message(s) left for the next run (maxPerRun=${cfg.maxPerRun}).`);
}

return keep.slice(0, cfg.maxPerRun).map(({ m, from, fromClub }) => ({
  json: {
    id: m.id,
    conversationId: m.conversationId || '',
    subject: m.subject || '',
    from,
    fromName: m.from?.emailAddress?.name || '',
    fromClub,
    folder: m.folder || '',
    replyTo: (m.replyTo || []).map((r) => String(r?.emailAddress?.address || '').trim().toLowerCase()).filter(Boolean),
    toRecipients: m.toRecipients || [],
    ccRecipients: m.ccRecipients || [],
    receivedDateTime: m.receivedDateTime,
    categories: m.categories || [],
    bodyType: m.body?.contentType || 'text',
    body: m.body?.content || m.bodyPreview || '',
  },
}));
