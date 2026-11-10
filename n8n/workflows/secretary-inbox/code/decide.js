// Code node "Decide" (Run Once for All Items).
// Input: one Check Claim result per email (its current categories), paired with
// that email's Claude API response (or an error item if the call failed).
// Output: the jobs to run for each email, in order:
//   kind "reply":    create a reply draft with `html`; send it now if `send`.
//   kind "notify":   email a held-message notice to cfg.notifyOnHold.
//   kind "finalize": set the email's categories (and flag it for review if `flag`).
// The last job of each email is always "finalize", or a "reply" with
// `finalize` set, so an email is only tagged done after its replies went out.
// Every job carries `failTag`: what "Tag Failed" sets if a step errors.

const cfg = $('Config').first().json;
const C = cfg.categories;
const live = cfg.mode === 'live';

const SIGN_OFF =
  '<p>With best regards,<br>The Office of the Secretary<br>The 1892 Club<br>110 E. Clayton St., Number 200, Athens, GA 30601</p>';

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function firstName(ctx) {
  const n = String(ctx.fromName || '').trim();
  if (!n || n.includes('@')) return '';
  const first = n.split(/[\s,]+/)[0];
  return /^[A-Za-z][A-Za-z'.-]*$/.test(first) ? first : '';
}

function templateHolding(ctx) {
  const name = firstName(ctx);
  return (
    `<p>${name ? `Dear ${esc(name)},` : 'Good day,'}</p>` +
    '<p>Thank you for writing to the 1892 Club. We have your message, and a member of the Club team will follow up with you personally.</p>' +
    SIGN_OFF
  );
}

// Claude's HTML may only be <p> and <br> tags without attributes, with no links,
// comments or character references. Anything else and we don't send it unread.
function safeHtml(html) {
  const s = String(html || '');
  if (/<!--|&#|javascript:/i.test(s)) return false;
  if (!(s.match(/<[^>]*>/g) || []).every((t) => /^<\/?(p|br)\s*\/?>$/i.test(t))) return false;
  const text = s.replace(/<[^>]*>/g, ' ');
  return !/(https?:\/\/|www\.|\bftp:)/i.test(text);
}

// Our own sign-off is generated, so allow its fixed text through the HTML check.
const okReply = (html) => safeHtml(String(html || '').replace(SIGN_OFF, '<p>sign-off</p>'));

// Pull the JSON decision out of a Messages API response.
// Returns { decision } or { problem, retryable }.
function parseClaude(res) {
  if (!res || typeof res !== 'object') return { problem: 'no response', retryable: true };
  if (res.error) {
    const e = res.error;
    const text = typeof e === 'string' ? e : `${e.message || ''} ${e.description || ''} ${JSON.stringify(e).slice(0, 300)}`;
    const status = Number(e.httpCode || e.status || e.statusCode || (text.match(/\b(408|429|5\d\d)\b/) || [])[1] || 0);
    const retryable = !status || status === 408 || status === 429 || status >= 500 || /timeout|ETIMEDOUT|ECONNRESET|overloaded|socket hang up/i.test(text);
    return { problem: `API error: ${(e.message || text).slice(0, 200)}`, retryable };
  }
  if (res.stop_reason === 'refusal') return { problem: 'Claude declined to answer (refusal)' };
  if (res.stop_reason === 'max_tokens') return { problem: 'reply was cut off (max_tokens)' };
  const text = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text) return { problem: 'empty response' };
  try {
    return { decision: JSON.parse(text) };
  } catch (err) {
    return { problem: `could not read JSON: ${err.message}` };
  }
}

const STAY_SILENT = ['spam_or_marketing', 'automated_notice'];

// Apply the hard rules on top of Claude's choice. Returns the final plan.
function plan(ctx, parsed) {
  const internal = ctx.senderIsStaff || (cfg.alwaysHoldSenders || []).map((s) => s.toLowerCase()).includes(ctx.from);
  // A website form's From is a relay; only the Reply-To person should hear back.
  const allowReplyAll = !(ctx.replyTo || []).length;

  if (parsed.problem) {
    return {
      action: 'hold',
      why: [`Claude could not draft a reply: ${parsed.problem}`],
      full: '',
      holding: templateHolding(ctx),
      replyAll: false,
      internal,
      summary: `Automatic drafting failed (${parsed.problem}). Please answer personally.`,
      category: 'other',
    };
  }

  const d = parsed.decision;
  const why = [];
  const flags = d.risk_flags || [];
  const missing = d.missing_facts || [];
  const base = { replyAll: allowReplyAll && d.reply_mode === 'reply_all', summary: d.summary_for_staff || '', category: d.category, internal };

  if (d.action === 'ignore') {
    if (STAY_SILENT.includes(d.category) || d.confidence >= 0.8) {
      return { ...base, action: 'ignore', why: ['Claude: no reply needed'] };
    }
    why.push(`Claude chose ignore at low confidence (${d.confidence}); holding instead`);
  }

  if (d.action === 'send') {
    if (!(d.confidence >= cfg.autoSendMinConfidence)) why.push(`confidence ${d.confidence} < ${cfg.autoSendMinConfidence}`);
    if (!(cfg.autoSendCategories || []).includes(d.category)) why.push(`category ${d.category} is not auto-send`);
    if (missing.length) why.push(`missing facts: ${missing.join('; ')}`);
    if (flags.length) why.push(`risk flags: ${flags.join(', ')}`);
    if (ctx.senderIsStaff) why.push('sender is Club staff');
    else if (internal) why.push('sender is on alwaysHoldSenders');
    if (!d.reply_html || d.reply_html.length < 40) why.push('reply is empty');
    if (d.reply_html && d.reply_html.length > 6000) why.push('reply is unusually long');
    if (d.reply_html && !d.reply_html.includes('Office of the Secretary')) why.push('reply lacks the sign-off');
    if (d.reply_html && !okReply(d.reply_html)) why.push('reply has HTML other than paragraphs, or a link');
    if (!why.length) return { ...base, action: 'send', why: ['all auto-send checks passed'], full: d.reply_html };
  } else if (d.action === 'hold') {
    if (missing.length) why.push(`missing facts: ${missing.join('; ')}`);
    if (flags.length) why.push(`risk flags: ${flags.join(', ')}`);
    if (!why.length) why.push('Claude chose to hold');
  }

  // Claude's holding reply goes out unread, so it must pass the same checks as
  // an auto-sent reply. For anything flagged risky, send the fixed template.
  const h = d.holding_reply_html || '';
  const useClaudes = !flags.length && h.length >= 40 && h.length <= 2000 && h.includes('Office of the Secretary') && okReply(h);
  return {
    ...base,
    action: 'hold',
    why,
    full: d.reply_html || '',
    holding: useClaudes ? h : templateHolding(ctx),
    holdingReplyAll: useClaudes && base.replyAll,
  };
}

function shadowNote(text) {
  return `<p style="color:#b00"><b>[Secretary shadow mode: ${esc(text)}. Nothing was sent. Delete this line before sending.]</b></p>`;
}

const jobs = [];
const items = $input.all();
for (let i = 0; i < items.length; i += 1) {
  const ctx = $('Build Claude Request').itemMatching(i).json;
  // Another run claimed this email after us (or already finished it): leave it
  // to that run. If we can't tell, do nothing; the email stays "Working" and a
  // later run takes it over safely.
  const now = items[i].json;
  if (now.error || !(now.categories || []).includes(cfg.claim)) continue;

  const keep = (ctx.categories || []).filter((c) => c !== C.processing && c !== C.retry && !String(c).startsWith(C.claimPrefix));
  const tags = (category, flag) => ({ categories: [...keep, category], flag: Boolean(flag) });
  const failTag = tags(C.held, true);
  const job = (fields) =>
    jobs.push({
      json: { messageId: ctx.id, subject: ctx.subject, replyTo: ctx.replyTo || [], failTag, ...fields },
      pairedItem: { item: i },
    });

  // A recovery run (an earlier run died part way) must never reply twice.
  if (ctx.recovery && (!ctx.threadKnown || ctx.alreadyReplied)) {
    const why = ctx.alreadyReplied
      ? 'an earlier run failed after a reply went out; check that the sender got a full answer'
      : 'an earlier run failed and the thread could not be read; a reply may already have gone out';
    if (live && (cfg.notifyOnHold || []).length) {
      job({ kind: 'notify', to: cfg.notifyOnHold, noticeSubject: `Check: ${ctx.subject || '(no subject)'}`, noticeHtml: `<p>${esc(why)}.</p>${ctx.webLink ? `<p><a href="${esc(ctx.webLink)}">Open the email in Outlook</a></p>` : ''}` });
    }
    job({ kind: 'finalize', finalize: tags(live ? C.held : C.shadow, live), log: { why: [why] } });
    continue;
  }

  const parsed = parseClaude($('Ask Claude').itemMatching(i).json);
  // A passing API problem: hand the email back to the next run to try once
  // more, but only if that run is early enough to still meet the reply goal.
  // Otherwise send the fixed holding reply now and hold it for review.
  const deadline = Date.parse(ctx.receivedDateTime) + cfg.replyWithinMinutes * 60000;
  const nextRunDone = Date.parse(cfg.nextPollAt) + 5 * 60000;
  if (parsed.retryable && !ctx.retried && nextRunDone <= deadline) {
    job({ kind: 'finalize', finalize: { categories: [...keep, C.retry], flag: false }, log: { why: [`will retry: ${parsed.problem}`] } });
    continue;
  }

  const p = plan(ctx, parsed);
  const log = { action: p.action, category: p.category, why: p.why, mode: cfg.mode };

  if (p.action === 'ignore') {
    job({ kind: 'finalize', finalize: tags(C.skipped, false), log });
    continue;
  }

  if (p.action === 'send') {
    job({
      kind: 'reply',
      replyAll: p.replyAll,
      html: live ? p.full : shadowNote('would SEND this reply automatically') + p.full,
      send: live,
      finalize: tags(live ? C.replied : C.shadow, false),
      log,
    });
    continue;
  }

  // Hold: save Claude's full draft for review, and (except for internal mail)
  // send a short holding reply now.
  const reasons = p.why.join('; ');
  if (p.full) {
    job({
      kind: 'reply',
      replyAll: p.replyAll,
      html: `<p style="color:#b00"><b>[Secretary draft for review. Held because: ${esc(reasons)}. Please check, edit and send.]</b></p>` + p.full,
      send: false,
      finalize: null,
      log,
    });
  }
  if (live && (cfg.notifyOnHold || []).length) {
    job({
      kind: 'notify',
      to: cfg.notifyOnHold,
      noticeSubject: `Held for review: ${ctx.subject || '(no subject)'}`,
      noticeHtml:
        `<p><b>From:</b> ${esc(ctx.fromName)} &lt;${esc(ctx.from)}&gt;<br><b>Subject:</b> ${esc(ctx.subject)}</p>` +
        `<p>${esc(p.summary)}</p><p><b>Why it was held:</b> ${esc(reasons)}</p>` +
        (ctx.webLink ? `<p><a href="${esc(ctx.webLink)}">Open the email in Outlook</a></p>` : ''),
      log,
    });
  }
  if (p.internal) {
    // Staff and internal handoffs: no "we will follow up" note to the Club's own people.
    job({ kind: 'finalize', finalize: tags(live ? C.held : C.shadow, live), log });
    continue;
  }
  job({
    kind: 'reply',
    replyAll: Boolean(p.holdingReplyAll),
    html: live ? p.holding : shadowNote(`would HOLD for review (${reasons}) and send this holding reply`) + p.holding,
    send: live,
    finalize: tags(live ? C.held : C.shadow, live),
    log,
  });
}

return jobs;
