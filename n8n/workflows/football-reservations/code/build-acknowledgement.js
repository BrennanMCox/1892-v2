// Code node "Build Acknowledgement" (Run Once for Each Item).
// Input: the reply draft Graph created (Create Acknowledgement). Also uses
// Plan Acknowledgement.
// Output: { draftId, to, patch }: the PATCH body that REPLACES the draft's body
// with the fixed acknowledgement alone (no quoted original, no earlier thread)
// and addresses it to ONE address (Reply-To if the email had one, else From).
// No Cc, no Bcc, never reply-all. The draft is still a reply (createReply), so
// it stays in the member's thread under "Re: <subject>".

const job = $('Plan Acknowledgement').item.json;
const draft = $json;
if (!draft.id) throw new Error('Create Acknowledgement returned no draft id');
if (job.send !== true || !job.to) throw new Error('no acknowledgement address');
if (!job.html) throw new Error('no acknowledgement text');

return {
  json: {
    draftId: draft.id,
    to: job.to,
    patch: {
      subject: job.subject,
      body: { contentType: 'HTML', content: job.html },
      toRecipients: [{ emailAddress: { address: job.to } }],
      ccRecipients: [],
      bccRecipients: [],
    },
  },
};
