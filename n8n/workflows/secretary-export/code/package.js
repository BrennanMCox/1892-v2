// Code node "Package" (Run Once for All Items).
// Input: every page Graph returned, for both folders. Output: the export split
// into JSON files small enough for one draft each (Graph caps a request at 4 MB).

const settings = $('Export Settings').first().json;
const KEEP_HEADERS = /^(message-id|in-reply-to|references|auto-submitted|precedence|list-id|list-unsubscribe|return-path|x-auto-response-suppress|x-autoreply|x-autorespond)$/i;
const MAX_PART = 2200000; // bytes of JSON per file; base64 grows it by a third
const bytes = (s) => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : unescape(encodeURIComponent(s)).length);

const seen = new Set();
const messages = [];
for (const item of $input.all()) {
  for (const m of item.json.value || []) {
    if (!m || !m.id || seen.has(m.id) || m.isDraft) continue;
    seen.add(m.id);
    messages.push({
      ...m,
      internetMessageHeaders: (m.internetMessageHeaders || []).filter((h) => KEEP_HEADERS.test(h.name)),
    });
  }
}
messages.sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));

const parts = [];
let current = [];
let size = 0;
for (const m of messages) {
  const s = bytes(JSON.stringify(m));
  if (current.length && size + s > MAX_PART) {
    parts.push(current);
    current = [];
    size = 0;
  }
  current.push(m);
  size += s;
}
if (current.length) parts.push(current);

const toBase64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))));
const stamp = new Date().toISOString().slice(0, 10);
return parts.map((p, i) => {
  const name = `secretary-export-${stamp}-part${i + 1}of${parts.length}.json`;
  const content = JSON.stringify({ format: 'graph-messages', mailbox: settings.mailbox, exportedAt: new Date().toISOString(), since: settings.since, part: i + 1, parts: parts.length, messages: p });
  return {
    json: {
      draft: {
        subject: `Secretary export ${i + 1} of ${parts.length} (${p.length} emails since ${settings.since.slice(0, 10)})`,
        body: {
          contentType: 'Text',
          content: 'Made by the Secretary Inbox Export workflow in n8n. Download the attached file for the replay test, then delete this draft. Nothing was sent.',
        },
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: 'application/json', contentBytes: toBase64(content) }],
      },
      emails: p.length,
    },
  };
});
