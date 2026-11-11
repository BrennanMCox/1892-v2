// Code node "Plan Acknowledgement" (Run Once for Each Item).
// Input: Recheck Tags (the email's categories as they are now, or an error).
// Also uses the message (Loop Messages), what was written (Plan Writes), the
// CRM (Load CRM) and the config.
// Output: { send, reason, to, firstName, subject, text, html, categories }.
//   send is true only when ALL of these hold:
//     - acknowledgement.enabled is true;
//     - Plan Writes wrote at least one new row (new_row or change_row), and the
//       write went through (this node is only reached after Write Sheet);
//     - the message is an Inbox message (folder 'inbox'; an unknown folder
//       counts as not Inbox) from someone outside the Club: not Sent Items,
//       not from the mailbox, not from a staff domain, not automated (From and
//       Reply-To);
//     - it has at most one Reply-To address;
//     - its fresh categories carry neither "Reservations: Acknowledged" nor
//       "Reservations: Acknowledging".
//   If all the other gates pass but the address is not usable, or the
//   categories could not be read (Recheck Tags failed), it throws, so the error output tags the email Logged + Needs
//   Review (an acknowledgement is owed and a person must send it).
//   to is the one address the acknowledgement goes to: the Reply-To address if
//   there is one, else From. Never Cc, Bcc or anyone else.
//   categories is passed through from Recheck Tags (when it read them) for Tag
//   Message.
// The text is a fixed template from the config (acknowledgement); Claude only
// suggests the first name the sender signed with, and that is checked here.

const cfg = $('Config').first().json;
const msg = $('Loop Messages').item.json;
const plan = $('Plan Writes').item.json;
const C = cfg.categories;
const A = cfg.acknowledgement || {};
const fresh = Array.isArray($json.categories) ? $json.categories : null;
const mailbox = String(cfg.mailboxAddress || '').toLowerCase();
const staff = (cfg.staffDomains || []).map((d) => String(d).toLowerCase());
const automated = (cfg.automatedSenders || []).map((s) => new RegExp(s, 'i'));

const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isStaff = (a) => {
  const domain = String(a).split('@')[1] || '';
  return staff.some((d) => domain === d || domain.endsWith(`.${d}`));
};

// The acknowledgement, as paragraphs of lines.
function paragraphs(firstName) {
  const fill = (t) => String(t).split('{phone}').join(A.phone || '');
  return [
    [firstName ? String(A.greeting).split('{name}').join(firstName) : A.greetingNoName],
    ...(A.paragraphs || []).map((p) => [fill(p)]),
    [...(A.signoff || [])],
  ];
}
const ackText = (firstName) => paragraphs(firstName).map((p) => p.join('\n')).join('\n\n');
const ackHtml = (firstName) => paragraphs(firstName).map((p) => `<p>${p.map(escHtml).join('<br>')}</p>`).join('\n');

// First names.
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|rev|the|hon|sir|dame|judge|prof|professor|capt|col|gen|gov|sen|rep)\.?$/i;
function firstWord(display) {
  const w = String(display || '').trim().split(/\s+/)[0] || '';
  if (!w || HONORIFIC.test(w) || /[,@&]/.test(w)) return '';
  return w;
}
// Claude's sender_first_name: letters (accented too), spaces, hyphens and
// apostrophes only, 1 to 30 characters, at least one letter, not a title.
function safeName(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 30) return '';
  if (!/^[\p{L}\p{M}' ’-]+$/u.test(t) || !/\p{L}/u.test(t)) return '';
  if (HONORIFIC.test(t)) return '';
  return t;
}

// The CRM's columns by header name, falling back to its fixed layout (A-O).
const crmValues = $('Load CRM').first().json.values || [];
const header = (crmValues[0] || []).map((h) => String(h).trim().toLowerCase());
const col = (name, fallback) => {
  const i = header.indexOf(name.toLowerCase());
  return i >= 0 ? i : fallback;
};
const COL = {
  display: col('Display Name', 1),
  first: col('First Name', 3),
  email: col('Email', 9),
  spouseDisplay: col("Spouse's Display Name", 11),
  spouseFirst: col("Spouse's First Name", 12),
  spouseEmail: col("Spouse's Email", 13),
};
const cell = (row, i) => String(row[i] ?? '').trim();
const addresses = (v) => String(v || '').toLowerCase().split(/[\s,;]+/).filter((a) => a.includes('@'));
// The CRM's name for an address: First Name (D) for a member, Spouse's First
// Name (M) for a spouse; if blank, the first word of the display name (B or L)
// unless it is a title. '' when the address is not in the CRM.
function crmFirstName(address) {
  for (const row of crmValues.slice(1)) {
    if (addresses(cell(row, COL.email)).includes(address)) return cell(row, COL.first) || firstWord(cell(row, COL.display));
  }
  for (const row of crmValues.slice(1)) {
    if (addresses(cell(row, COL.spouseEmail)).includes(address)) return cell(row, COL.spouseFirst) || firstWord(cell(row, COL.spouseDisplay));
  }
  return '';
}

const passCats = fresh ? { categories: fresh } : {};
const no = (reason) => ({ json: { send: false, reason, ...passCats } });

function decide() {
  if (A.enabled !== true) return no('acknowledgements are turned off');
  if (plan.route !== 'write' || plan.acknowledge !== true) return no('no new or changed request was written');
  if (msg.fromClub || msg.folder !== 'inbox') return no('not an Inbox message (Sent Items, a Club message, or folder unknown)');
  const from = String(msg.from || '').trim().toLowerCase();
  const replyTo = (msg.replyTo || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (!from || from === mailbox || replyTo.includes(mailbox)) return no('from the mailbox itself');
  if (isStaff(from) || replyTo.some(isStaff)) return no('from staff');
  if ([from, ...replyTo].some((a) => automated.some((re) => re.test(a)))) return no('automated sender');
  if (replyTo.length > 1) return no('more than one Reply-To address');
  const to = replyTo[0] || from;
  if (fresh && fresh.includes(C.acknowledged)) return no('already acknowledged');
  if (fresh && fresh.includes(C.acknowledging)) return no('an acknowledgement was already started');
  // An acknowledgement is owed but cannot be sent safely: the email goes to the
  // error output (Tag Ack Failed: Logged + Needs Review) for a person to send it.
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(to)) throw new Error(`Plan Acknowledgement: not a usable address (${to}); acknowledge it by hand`);
  if (!fresh) throw new Error('Plan Acknowledgement: could not read the email\'s categories; acknowledge it by hand');

  const firstName = crmFirstName(to) || safeName(plan.senderFirstName);
  const subjectIn = String(msg.subject || '').trim();
  const subject = /^re:/i.test(subjectIn) ? subjectIn : `Re: ${subjectIn}`.trim();
  return {
    json: { send: true, reason: 'new or changed request logged', to, firstName, subject, text: ackText(firstName), html: ackHtml(firstName), ...passCats },
  };
}

return decide();
