// Code node "Match CRM" (Run Once for All Items).
// Input: the CRM (Load CRM, read once for the run). Also uses the messages
// Select Messages kept.
// Output: every selected message, one at a time for the loop, with:
//   member:       true when the address the reply would go to (Reply-To if the
//                 email has one, else From) is a member's Email (column J) or a
//                 Spouse's Email (column N) in the CRM, ignoring case;
//   replyAddress: that address (the only recipient a reply ever has);
//   matchedAs:    "member" or "spouse";
//   firstName:    the name the reply greets: First Name (D) for a member,
//                 Spouse's First Name (M) for a spouse; if blank, the first word
//                 of Display Name (B) or Spouse's Display Name (L); else "".
//   skipReason:   why a non-member gets no reply (tagged "OpenTable: No Reply"),
//                 or the reason Select Messages already gave (staff, automated).
//                 A message with a skipReason is never a member here.

const crmValues = $input.first().json.values || [];
const messages = $('Select Messages').all().map((i) => i.json);

// Columns by header name, falling back to the CRM's fixed layout (A-O).
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
// A cell may hold more than one address.
const addresses = (v) => String(v || '').toLowerCase().split(/[\s,;]+/).filter((a) => a.includes('@'));

const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|rev|the|hon)\.?$/i;
function firstWord(display) {
  const w = String(display || '').trim().split(/\s+/)[0] || '';
  if (!w || HONORIFIC.test(w) || /[,@&]/.test(w)) return '';
  return w;
}

function findMember(address) {
  for (const row of crmValues.slice(1)) {
    if (addresses(cell(row, COL.email)).includes(address)) {
      return { matchedAs: 'member', firstName: cell(row, COL.first) || firstWord(cell(row, COL.display)) };
    }
  }
  for (const row of crmValues.slice(1)) {
    if (addresses(cell(row, COL.spouseEmail)).includes(address)) {
      return { matchedAs: 'spouse', firstName: cell(row, COL.spouseFirst) || firstWord(cell(row, COL.spouseDisplay)) };
    }
  }
  return null;
}

return messages.map((msg) => {
  const replyTo = (msg.replyTo || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  let replyAddress = '';
  let skipReason = msg.skipReason || '';
  if (skipReason) {
    return { json: { ...msg, member: false, replyAddress: '', matchedAs: '', firstName: '', skipReason } };
  }
  if (replyTo.length > 1) skipReason = 'more than one Reply-To address';
  else replyAddress = replyTo[0] || String(msg.from || '').trim().toLowerCase();
  const match = replyAddress ? findMember(replyAddress) : null;
  if (!skipReason && !match) skipReason = `${replyAddress || 'the sender'} is not in the CRM`;
  return {
    json: {
      ...msg,
      member: Boolean(match) && !skipReason,
      replyAddress: match && !skipReason ? replyAddress : '',
      matchedAs: match?.matchedAs || '',
      firstName: match && !skipReason ? match.firstName : '',
      skipReason,
    },
  };
});
