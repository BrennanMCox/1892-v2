// Code node "Decide" (Run Once for All Items).
// Input: one Claude API response per email (or an error item if the call failed).
// Output: the jobs to run for each email, in order:
//   kind "reply":    create a reply draft with `html`; send it now if `send`.
//   kind "finalize": tag the original email (and flag it for Joel if held).
//   kind "notify":   email a held-message notice to cfg.notifyOnHold.
// The last job of each email is always "finalize" or a "reply" with finalize set,
// so an email is only tagged done after its replies went out.

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
    '<p>Thank you for writing to the 1892 Club. We have your message, and Joel Guerrero-Sparks, our Club Secretary, will follow up with you personally.</p>' +
    SIGN_OFF
  );
}

// Pull the JSON decision out of a Messages API response. Returns { decision } or { problem }.
function parseClaude(res) {
  if (!res || typeof res !== 'object') return { problem: 'no response' };
  if (res.error) {
    const e = res.error;
    return { problem: `API error: ${typeof e === 'string' ? e : e.message || JSON.stringify(e).slice(0, 300)}` };
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
  if (parsed.problem) {
    return {
      action: 'hold',
      why: [`Claude could not draft a reply: ${parsed.problem}`],
      full: '',
      holding: templateHolding(ctx),
      replyAll: false,
      summary: `Automatic drafting failed (${parsed.problem}). A holding reply was sent; please answer personally.`,
      category: 'other',
    };
  }

  const d = parsed.decision;
  const why = [];
  const replyAll = d.reply_mode === 'reply_all';
  const base = { replyAll, summary: d.summary_for_joel || '', category: d.category };

  if (d.action === 'ignore') {
    if (STAY_SILENT.includes(d.category) || d.confidence >= 0.8) {
      return { ...base, action: 'ignore', why: ['Claude: no reply needed'] };
    }
    why.push(`Claude chose ignore at low confidence (${d.confidence}); holding instead`);
  }

  const flags = d.risk_flags || [];
  const missing = d.missing_facts || [];
  if (d.action === 'send') {
    if (!(d.confidence >= cfg.autoSendMinConfidence)) why.push(`confidence ${d.confidence} < ${cfg.autoSendMinConfidence}`);
    if (!(cfg.autoSendCategories || []).includes(d.category)) why.push(`category ${d.category} is not auto-send`);
    if (missing.length) why.push(`missing facts: ${missing.join('; ')}`);
    if (flags.length) why.push(`risk flags: ${flags.join(', ')}`);
    if (ctx.senderIsStaff) why.push('sender is Club staff');
    if ((cfg.alwaysHoldSenders || []).map((s) => s.toLowerCase()).includes(ctx.from)) why.push('sender is on alwaysHoldSenders');
    if (!d.reply_html || d.reply_html.length < 40) why.push('reply is empty');
    if (d.reply_html && d.reply_html.length > 12000) why.push('reply is unusually long');
    if (d.reply_html && !d.reply_html.includes('Office of the Secretary')) why.push('reply lacks the sign-off');
    if (/<(script|style|img|iframe|form|a\s)/i.test(d.reply_html || '')) why.push('reply contains disallowed HTML');
    if (!why.length) return { ...base, action: 'send', why: ['all auto-send checks passed'], full: d.reply_html };
  } else if (d.action === 'hold') {
    why.push(...(missing.length ? [`missing facts: ${missing.join('; ')}`] : []), ...(flags.length ? [`risk flags: ${flags.join(', ')}`] : []));
    if (!why.length) why.push('Claude chose to hold');
  }

  const holding = d.holding_reply_html && d.holding_reply_html.length >= 40 && !/<(script|style|img|iframe|form)/i.test(d.holding_reply_html)
    ? d.holding_reply_html
    : templateHolding(ctx);
  return { ...base, action: 'hold', why, full: d.reply_html || '', holding };
}

function shadowNote(text) {
  return `<p style="color:#b00"><b>[Secretary shadow mode: ${esc(text)}. Nothing was sent. Delete this line before sending.]</b></p>`;
}

const jobs = [];
const items = $input.all();
for (let i = 0; i < items.length; i += 1) {
  const ctx = $('Build Claude Request').itemMatching(i).json;
  const paired = { pairedItem: { item: i } };
  const keep = (ctx.categories || []).filter((c) => c !== C.processing);
  const finalize = (category, flag) => ({ categories: [...keep, category], flag: Boolean(flag) });
  const job = (fields) =>
    jobs.push({ json: { messageId: ctx.id, subject: ctx.subject, replyTo: ctx.replyTo || [], ...fields }, ...paired });

  if (ctx.alreadyReplied) {
    job({ kind: 'finalize', finalize: finalize(live ? C.replied : C.shadow, false), why: ['a reply was already sent'] });
    continue;
  }

  const p = plan(ctx, parseClaude(items[i].json));
  const log = { action: p.action, category: p.category, why: p.why, mode: cfg.mode };

  if (p.action === 'ignore') {
    job({ kind: 'finalize', finalize: finalize(C.skipped, false), log });
    continue;
  }

  if (p.action === 'send') {
    job({
      kind: 'reply',
      replyAll: p.replyAll,
      html: live ? p.full : shadowNote('would SEND this reply automatically') + p.full,
      send: live,
      finalize: finalize(live ? C.replied : C.shadow, false),
      log,
    });
    continue;
  }

  // Hold: save Claude's full draft for Joel, send a short holding reply now.
  const reasons = p.why.join('; ');
  if (p.full) {
    job({
      kind: 'reply',
      replyAll: p.replyAll,
      html: `<p style="color:#b00"><b>[Secretary draft for Joel. Held because: ${esc(reasons)}. Please check, edit and send.]</b></p>` + p.full,
      send: false,
      finalize: null,
      log,
    });
  }
  if (live && (cfg.notifyOnHold || []).length) {
    job({
      kind: 'notify',
      to: cfg.notifyOnHold,
      noticeSubject: `Held for Joel: ${ctx.subject || '(no subject)'}`,
      noticeHtml:
        `<p><b>From:</b> ${esc(ctx.fromName)} &lt;${esc(ctx.from)}&gt;<br><b>Subject:</b> ${esc(ctx.subject)}</p>` +
        `<p>${esc(p.summary)}</p><p><b>Why it was held:</b> ${esc(reasons)}</p>` +
        (ctx.webLink ? `<p><a href="${esc(ctx.webLink)}">Open the email in Outlook</a></p>` : ''),
      finalize: null,
      log,
    });
  }
  job({
    kind: 'reply',
    replyAll: p.replyAll,
    html: live ? p.holding : shadowNote(`would HOLD for Joel (${reasons}) and send this holding reply`) + p.holding,
    send: live,
    finalize: finalize(live ? C.held : C.shadow, live),
    log,
  });
}

return jobs;
