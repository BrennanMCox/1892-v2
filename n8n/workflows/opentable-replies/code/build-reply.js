// Code node "Build Reply" (Run Once for Each Item).
// Input: the reply draft Graph created (Create Reply), which already holds the
// quoted original email. Output: the PATCH body that puts
// the fixed OpenTable note above the quote and sends it to ONE address: the
// member who wrote (Reply-To if set, else From). No Cc, no Bcc, never reply-all.

const job = $('Decide').item.json;
const draft = $json;
if (!draft.id) throw new Error('Create Reply returned no draft id');
if (!job.replyAddress) throw new Error('no reply address');
if (!job.subject) throw new Error('no subject');
const existing = String(draft.body?.content || '');
const ours = `<div id="opentable-reply">${job.html}</div>`;

let content;
const bodyTag = existing.match(/<body[^>]*>/i);
if (bodyTag) {
  const at = bodyTag.index + bodyTag[0].length;
  content = existing.slice(0, at) + ours + existing.slice(at);
} else if (existing && String(draft.body?.contentType).toLowerCase() === 'html') {
  content = ours + existing;
} else {
  const quoted = existing.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  content = ours + (quoted ? `<hr>${quoted}` : '');
}

return {
  json: {
    draftId: draft.id,
    to: job.replyAddress,
    patch: {
      subject: job.subject,
      body: { contentType: 'HTML', content },
      toRecipients: [{ emailAddress: { address: job.replyAddress } }],
      ccRecipients: [],
      bccRecipients: [],
    },
  },
};
