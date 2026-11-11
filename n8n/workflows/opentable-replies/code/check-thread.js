// Code node "Check Thread" (Run Once for Each Item).
// Input: Get Thread (every message in the conversation: id, from, dates,
// categories, isDraft). Also uses the message (Loop Messages) and the config.
// Output: { ok, reason }. ok is false (no reply) when the conversation has:
//   - a message from the mailbox (a Club reply) sent after the member's message;
//   - any draft (someone at the Club may be writing a reply);
//   - any other message already tagged "OpenTable: Replied" or "OpenTable:
//     Sending" (at most one OpenTable reply per conversation);
//   - a later message from anyone else (the newer one is judged on its own turn);
//   - no conversation id, or a result that does not include the message itself.

const cfg = $('Config').first().json;
const msg = $('Loop Messages').item.json;
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();
const DONE = [cfg.categories.replied, cfg.categories.sending];

const thread = Array.isArray($json.value) ? $json.value : null;
if (!thread) return { json: { ok: false, reason: 'could not read the conversation' } };
// The member's own message must be in what Get Thread returned; otherwise the
// result is not the whole conversation (or no conversation at all) and a Club
// reply could be missing from it.
if (!msg.conversationId) return { json: { ok: false, reason: 'the message has no conversation id' } };
if (!thread.some((m) => m && m.id === msg.id)) return { json: { ok: false, reason: 'the conversation as read does not include this message' } };

const at = (m) => Date.parse(m.sentDateTime || m.receivedDateTime);
const msgAt = Math.min(...[Date.parse(msg.sentDateTime), Date.parse(msg.receivedDateTime)].filter(Number.isFinite));
let reason = '';
for (const m of thread) {
  if (!m || m.id === msg.id) continue;
  const from = String(m.from?.emailAddress?.address || '').toLowerCase();
  const when = at(m);
  if ((m.categories || []).some((c) => DONE.includes(c))) {
    reason = 'the conversation already has an OpenTable reply';
    break;
  }
  if (m.isDraft) {
    reason = 'the conversation has a draft reply';
    break;
  }
  if (from === mailbox && !(when < msgAt)) {
    reason = 'the Club has already replied';
    break;
  }
  if (from !== mailbox && !(when <= msgAt)) {
    reason = 'a newer message in the conversation';
    break;
  }
}

return { json: { ok: !reason, reason } };
