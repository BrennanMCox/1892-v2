// Reads exported emails (.eml files, or .mbox files holding many) into the
// same shape Microsoft Graph returns, so the replay tool can feed them through
// the workflow's own code. No dependencies.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// ---- low level -------------------------------------------------------------

function decodeBytes(buf, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'ascii' || cs === 'us-ascii' ? 'utf-8' : cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function qpToBytes(s) {
  const clean = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) {
      out.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...Buffer.from(c, 'latin1'));
    }
  }
  return Buffer.from(out);
}

// RFC 2047 encoded words in headers: =?utf-8?B?...?= and =?utf-8?Q?...?=
export function decodeWords(value) {
  return String(value || '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, text) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qpToBytes(text.replace(/_/g, ' '));
      return decodeBytes(bytes, cs.split('*')[0]);
    });
}

function splitHeaderBody(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

export function parseHeaders(head) {
  const list = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && list.length) list[list.length - 1].value += ` ${line.trim()}`;
    else {
      const i = line.indexOf(':');
      if (i > 0) list.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  return list;
}

const get = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function param(value, key) {
  const m = String(value).match(new RegExp(`${key}\\*?=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? (m[2] ?? m[1]).replace(/^"|"$/g, '') : '';
}

// Returns { html, text } for a MIME entity (recursing into multiparts).
function bodies(head, body, raw) {
  const headers = parseHeaders(head);
  const type = (get(headers, 'Content-Type') || 'text/plain').toLowerCase();
  const cte = get(headers, 'Content-Transfer-Encoding').toLowerCase();
  const disp = get(headers, 'Content-Disposition').toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(get(headers, 'Content-Type'), 'boundary');
    if (!boundary) return { html: '', text: '' };
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    const out = { html: '', text: '' };
    for (const part of parts.slice(1)) {
      if (!part.trim()) continue;
      const { head: h, body: b } = splitHeaderBody(part);
      const got = bodies(h, b, raw);
      if (!out.html && got.html) out.html = got.html;
      if (!out.text && got.text) out.text = got.text;
    }
    return out;
  }
  if (disp.startsWith('attachment')) return { html: '', text: '' };
  if (!type.startsWith('text/')) return { html: '', text: '' };
  // Bodies were read as latin1, so each char is one original byte.
  const bytes = cte === 'base64'
    ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
    : cte === 'quoted-printable'
      ? qpToBytes(body)
      : Buffer.from(body, 'latin1');
  const text = decodeBytes(bytes, param(get(headers, 'Content-Type'), 'charset') || 'utf-8');
  return type.startsWith('text/html') ? { html: text, text: '' } : { html: '', text };
}

// "Ann Fox" <ann@x.com>, bob@y.com  ->  [{ emailAddress: { name, address } }]
export function parseAddresses(value) {
  const out = [];
  const s = decodeWords(value);
  let buf = '';
  let quoted = false;
  let angle = 0;
  const push = () => {
    const part = buf.trim();
    buf = '';
    if (!part) return;
    const m = part.match(/^(.*)<([^>]+)>\s*$/);
    const address = (m ? m[2] : part).trim().replace(/^mailto:/i, '');
    if (!address.includes('@')) return;
    const name = m ? m[1].trim().replace(/^"|"$/g, '').trim() : '';
    out.push({ emailAddress: { name: name || address, address } });
  };
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle += 1;
    if (!quoted && ch === '>') angle -= 1;
    if (ch === ',' && !quoted && angle <= 0) push();
    else buf += ch;
  }
  push();
  return out;
}

const ids = (value) => (String(value || '').match(/<[^>]+>/g) || []).map((x) => x.toLowerCase());

// ---- messages ----------------------------------------------------------------

// One raw RFC 822 message -> a Graph-like message object.
export function parseEml(raw, fallbackId = '') {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  const { head, body } = splitHeaderBody(text);
  const headers = parseHeaders(head).map((h) => ({ name: h.name, value: decodeWords(h.value) }));
  const rawHeaders = parseHeaders(head);
  const { html, text: plain } = bodies(head, body, text);
  const date = new Date(get(rawHeaders, 'Date'));
  const when = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const from = parseAddresses(get(rawHeaders, 'From'))[0] || null;
  const messageId = ids(get(rawHeaders, 'Message-ID'))[0] || `<${fallbackId || Math.random().toString(36).slice(2)}@replay>`;
  return {
    id: messageId,
    internetMessageId: messageId,
    inReplyTo: ids(get(rawHeaders, 'In-Reply-To')),
    references: ids(get(rawHeaders, 'References')),
    subject: decodeWords(get(rawHeaders, 'Subject')),
    from,
    sender: from,
    replyTo: parseAddresses(get(rawHeaders, 'Reply-To')),
    toRecipients: parseAddresses(get(rawHeaders, 'To')),
    ccRecipients: parseAddresses(get(rawHeaders, 'Cc')),
    receivedDateTime: when.toISOString(),
    sentDateTime: when.toISOString(),
    lastModifiedDateTime: when.toISOString(),
    categories: [],
    isDraft: false,
    webLink: '',
    body: html ? { contentType: 'html', content: html } : { contentType: 'text', content: plain },
    bodyPreview: (plain || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 255),
    internetMessageHeaders: headers,
  };
}

// A message from Graph (the Secretary Inbox Export workflow) -> the same shape
// parseEml produces.
export function fromGraph(m) {
  const header = (name) => (m.internetMessageHeaders || []).find((h) => h.name.toLowerCase() === name)?.value || '';
  const content = m.body?.content || '';
  const isHtml = String(m.body?.contentType).toLowerCase() === 'html';
  return {
    ...m,
    id: m.internetMessageId?.toLowerCase() || m.id,
    graphConversationId: m.conversationId,
    inReplyTo: ids(header('in-reply-to')),
    references: ids(header('references')),
    sentDateTime: m.sentDateTime || m.receivedDateTime,
    lastModifiedDateTime: m.receivedDateTime,
    categories: [],
    isDraft: false,
    webLink: '',
    replyTo: m.replyTo || [],
    toRecipients: m.toRecipients || [],
    ccRecipients: m.ccRecipients || [],
    body: { contentType: isHtml ? 'html' : 'text', content },
    bodyPreview: (isHtml ? content.replace(/<[^>]+>/g, ' ') : content).replace(/\s+/g, ' ').trim().slice(0, 255),
  };
}

// Splits an mbox file into raw messages.
export function splitMbox(text) {
  return text
    .split(/\r?\n(?=From [^\r\n]*\r?\n)/)
    .map((m) => m.replace(/^From [^\r\n]*\r?\n/, '').replace(/^>(>*From )/gm, '$1'))
    .filter((m) => m.trim());
}

// Every .eml / .mbox under a folder (or a single file).
export function loadMessages(path) {
  const files = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else files.push(p);
  };
  walk(path);
  const messages = [];
  const skipped = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (ext === '.eml') messages.push(parseEml(readFileSync(f), f));
    else if (ext === '.json') {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (data?.format === 'graph-messages') messages.push(...data.messages.map(fromGraph));
      else skipped.push(f);
    } else if (ext === '.mbox' || ext === '.mbx') {
      splitMbox(readFileSync(f).toString('latin1')).forEach((raw, i) => messages.push(parseEml(raw, `${f}#${i}`)));
    } else skipped.push(f);
  }
  // The same message exported twice counts once.
  const seen = new Set();
  return { messages: messages.filter((m) => !seen.has(m.id) && seen.add(m.id)), skipped };
}

// Groups messages into threads (Message-ID / In-Reply-To / References, then
// subject) and sets conversationId on each.
export function threadMessages(messages) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
    parent.set(find(a), find(b));
  };
  const subjectKey = (s) => `subject:${String(s || '').toLowerCase().replace(/^(\s*(re|fw|fwd|aw|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim()}`;
  const isReply = (m) => /^\s*(re|fw|fwd|aw|sv)\s*:/i.test(m.subject || '');
  const byDate = [...messages].sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
  const lastBySubject = new Map();
  for (const m of byDate) {
    union(m.id, m.id);
    for (const r of [...m.inReplyTo, ...m.references]) union(m.id, r);
    if (m.graphConversationId) union(m.id, `conv:${m.graphConversationId}`);
    // Subject only links a reply that lost its threading headers to the latest
    // earlier message with the same subject; two separate "Reservation" emails
    // stay separate threads.
    const key = subjectKey(m.subject);
    const hasHeaders = m.inReplyTo.length || m.references.length;
    if (key !== 'subject:' && isReply(m) && !hasHeaders && lastBySubject.has(key)) union(m.id, lastBySubject.get(key));
    if (key !== 'subject:') lastBySubject.set(key, m.id);
  }
  for (const m of messages) m.conversationId = find(m.id);
  return messages;
}
