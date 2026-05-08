// Phone-number normalization. Accepts a variety of human formats and returns
// E.164-without-plus (the form WhatsApp JIDs use). Returns null if the input
// can't plausibly be a phone number.
//
// Heuristics:
//   - Strip all non-digits except a leading '+'
//   - If starts with '+', drop the '+' and trust the digits as international
//   - If starts with '00', drop and trust the rest as international
//   - If looks like a domestic Israeli number (starts with '0' and has 9-10
//     digits), drop the leading 0 and prepend 972
//   - Otherwise return the digits as-is (assume already international)

function normalizePhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Keep a possible leading + then strip everything non-digit
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;

  if (hasPlus) return s;
  if (s.startsWith('00')) return s.slice(2);

  // Israeli domestic: leading 0, 9 or 10 total digits
  if (s.startsWith('0') && (s.length === 9 || s.length === 10)) {
    return '972' + s.slice(1);
  }

  return s;
}

// Best-effort pretty-print for display. Currently only Israeli international
// (972XXXXXXXXX) gets a friendly local-format echo; others returned as-is.
function displayPhone(digits) {
  if (!digits) return '';
  const s = String(digits);
  if (s.startsWith('972')) {
    const rest = s.slice(3);
    if (rest.length >= 8) {
      // 0XX-XXX-XXXX
      return `0${rest.slice(0, 2)}-${rest.slice(2, 5)}-${rest.slice(5)}`;
    }
  }
  return '+' + s;
}

module.exports = { normalizePhone, displayPhone };
