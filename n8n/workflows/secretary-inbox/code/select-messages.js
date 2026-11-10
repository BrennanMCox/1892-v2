// Code node "Select Messages" (Run Once for All Items).
// Input: one item, the Graph response of List Inbox ({ value: [message, ...] }).
// Output: one item per message worth acting on, oldest first, with route:
//   "answer": a real person wrote; draft and send/hold a reply. `working` is
//             the category list Tag Working sets.
//   "skip":   automated or our own mail; tag it (`tagNow`) so it is never
//             looked at again.
//   "giveup": two runs in a row died on this email; flag it for review (`tagNow`)
//             without trying again.

const cfg = $('Config').first().json;
const C = cfg.categories;
const FINAL = [C.replied, C.held, C.skipped, C.shadow];
const now = Date.now();
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();

const cutoff = Math.max(
  Date.parse(cfg.processReceivedAfter) || 0,
  now - cfg.maxAgeHours * 3600 * 1000,
);

function header(m, name) {
  const h = (m.internetMessageHeaders || []).find(
    (x) => String(x.name).toLowerCase() === name.toLowerCase(),
  );
  return h ? String(h.value) : '';
}

// Returns a reason string when the message is machine-sent, else ''.
// `from` is who a reply would go to (Reply-To if set, else From): website forms
// often send from no-reply@ with the real person in Reply-To.
function automatedReason(m, from) {
  const type = String(m['@odata.type'] || '');
  if (/eventMessage|calendarSharingMessage/i.test(type)) return 'meeting invitation or response';
  if (/^(undeliverable|delivery status notification|mail delivery failed)/i.test(m.subject || '')) return 'bounce';
  if (header(m, 'Return-Path').trim() === '<>') return 'bounce (empty Return-Path)';
  const auto = header(m, 'Auto-Submitted').toLowerCase();
  if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`;
  const prec = header(m, 'Precedence').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(prec)) return `Precedence: ${prec}`;
  if (header(m, 'List-Unsubscribe') || header(m, 'List-Id')) return 'mailing list';
  if (header(m, 'X-Autoreply') || header(m, 'X-Autorespond')) return 'auto-reply header';
  const suppress = header(m, 'X-Auto-Response-Suppress').toLowerCase();
  if (/\ball\b|\boof\b|\bautoreply\b/.test(suppress)) return `X-Auto-Response-Suppress: ${suppress}`;
  const local = from.split('@')[0] || '';
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)\b/.test(local)) {
    return `sender ${local}@`;
  }
  if (!from) return 'no sender address';
  return '';
}

// List Inbox follows Graph's paging, so there may be several pages (items).
const pages = $input.all().map((i) => i.json);
const messages = pages.flatMap((p) => p.value || []);
if (pages.length && pages[pages.length - 1]['@odata.nextLink']) {
  console.log('Select Messages: more mail in the window than the page limit; the oldest is left for later runs.');
}
const isOurs = (c) => c === C.processing || c === C.retry || String(c).startsWith(C.claimPrefix);
messages.sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));

const out = [];
let deferred = 0;
let answered = 0;
for (const m of messages) {
  const received = Date.parse(m.receivedDateTime);
  if (!(received >= cutoff)) continue;
  if (m.isDraft) continue;

  const cats = m.categories || [];
  if (cats.some((c) => FINAL.includes(c))) continue;

  const retried = cats.includes(C.retry);
  const keep = cats.filter((c) => !isOurs(c));
  let recovery = false;
  if (cats.includes(C.processing)) {
    // Another run is (or was) working on it. Take it over only once that run
    // has certainly ended: tagging sets lastModifiedDateTime, and runs time out.
    const touched = Date.parse(m.lastModifiedDateTime) || received;
    if (now - touched < cfg.stuckAfterMinutes * 60 * 1000) continue;
    recovery = true;
  }

  const from = String(m.from?.emailAddress?.address || m.sender?.emailAddress?.address || '').toLowerCase();
  const replyTo = (m.replyTo || []).filter((r) => r.emailAddress?.address);
  const replyAddress = String(replyTo[0]?.emailAddress?.address || from).toLowerCase();
  let route = 'answer';
  let skipReason = '';
  if (mailbox && (from === mailbox || replyAddress === mailbox)) {
    route = 'skip';
    skipReason = 'sent by this mailbox';
  } else {
    skipReason = automatedReason(m, replyAddress);
    if (skipReason) route = 'skip';
  }
  if (route === 'answer' && recovery && retried) {
    route = 'giveup';
    skipReason = 'two runs failed on this email';
  }

  // Only emails that go to Claude count toward the cap; tagging is cheap.
  if (route === 'answer') {
    if (answered >= cfg.maxPerRun) {
      deferred += 1;
      continue;
    }
    answered += 1;
  }

  let tagNow = null;
  if (route === 'skip') tagNow = { categories: [...keep, C.skipped], flag: false };
  if (route === 'giveup') tagNow = { categories: [...keep, C.held], flag: true };
  // A recovery attempt is marked "retry", so if it dies too we give up next time.
  const working = [...keep, C.processing, ...(recovery || retried ? [C.retry] : []), cfg.claim];

  out.push({
    json: {
      route,
      skipReason,
      recovery,
      retried,
      tagNow,
      working,
      id: m.id,
      conversationId: m.conversationId,
      subject: m.subject || '',
      from: replyAddress,
      fromName: (replyTo.length ? replyTo[0].emailAddress.name : m.from?.emailAddress?.name) || '',
      sentFrom: from,
      replyTo,
      toRecipients: m.toRecipients || [],
      ccRecipients: m.ccRecipients || [],
      receivedDateTime: m.receivedDateTime,
      categories: cats,
      webLink: m.webLink || '',
      bodyType: m.body?.contentType || 'text',
      body: m.body?.content || m.bodyPreview || '',
    },
  });
}

if (deferred) {
  console.log(`Select Messages: ${deferred} more message(s) left for the next run (maxPerRun=${cfg.maxPerRun}).`);
}

return out;
