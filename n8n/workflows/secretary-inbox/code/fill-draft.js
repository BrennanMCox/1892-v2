// Code node "Fill Draft" (Run Once for Each Item).
// Input: the reply draft Graph created (createReply / createReplyAll), which
// already holds the quoted original email. Output: the PATCH body that puts our
// reply above the quote.

const job = $('Decide').item.json;
const draft = $json;
const existing = String(draft.body?.content || '');
const ours = `<div id="secretary-reply">${job.html}</div>`;

let content;
const bodyTag = existing.match(/<body[^>]*>/i);
if (bodyTag) {
  const at = bodyTag.index + bodyTag[0].length;
  content = existing.slice(0, at) + ours + existing.slice(at);
} else if (existing && String(draft.body?.contentType).toLowerCase() === 'html') {
  content = ours + existing;
} else {
  const quoted = existing
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  content = ours + (quoted ? `<hr>${quoted}` : '');
}

const patch = { body: { contentType: 'HTML', content } };
// Graph replies to From even when the email asked for replies to go elsewhere
// (Reply-To, e.g. a website form). Honour Reply-To on a plain reply.
if (!job.replyAll && (job.replyTo || []).length) {
  patch.toRecipients = job.replyTo.map((r) => ({ emailAddress: { address: r.emailAddress.address, name: r.emailAddress.name || '' } }));
}

return { json: { draftId: draft.id, patch } };
