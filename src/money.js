'use strict';

// All money in this app is an integer number of cents. Floats never touch it:
// parsing is done on the digit strings, formatting is done with integer math.

/**
 * Parse a user-entered dollar amount into integer cents.
 *
 * Accepts things an Android decimal keypad and a copy/paste can produce:
 *   "12", "12.3", "12.34", "$1,234.56", " 0.07 ", ".50", "12."
 * Rejects anything else, including more than two decimal places, so a typo
 * like "12.345" is a visible error instead of a silently rounded charge.
 *
 * @param {string} input
 * @returns {{ok: true, cents: number} | {ok: false, error: string}}
 */
function parseAmount(input) {
  if (typeof input !== 'string') return { ok: false, code: 'empty', error: 'Enter an amount.' };

  // Strip currency noise: whitespace, a leading $, and thousands separators.
  let s = input.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (s === '') return { ok: false, code: 'empty', error: 'Enter an amount.' };

  // A leading "-" is not accepted. Direction is chosen by which form was used
  // (charge vs. payment), never by typing a sign into the amount box.
  if (!/^\d*(?:\.\d*)?$/.test(s)) {
    return { ok: false, code: 'format', error: 'Enter a dollar amount like 12.34' };
  }

  const [whole, frac = ''] = s.split('.');
  if (whole === '' && frac === '') {
    return { ok: false, code: 'format', error: 'Enter a dollar amount like 12.34' };
  }
  if (frac.length > 2) {
    return { ok: false, code: 'decimals', error: 'Amounts can have at most two decimal places.' };
  }

  const dollars = whole === '' ? 0 : Number(whole);
  const cents = Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(dollars)) {
    return { ok: false, code: 'too_large', error: 'That amount is too large.' };
  }

  const total = dollars * 100 + cents;
  if (!Number.isSafeInteger(total)) {
    return { ok: false, code: 'too_large', error: 'That amount is too large.' };
  }
  if (total === 0) return { ok: false, code: 'zero', error: 'Enter an amount greater than zero.' };
  // Keep a sane ceiling so one fat-fingered entry can not wreck a balance.
  if (total > 100_000_000_00) return { ok: false, code: 'too_large', error: 'That amount is too large.' };

  return { ok: true, cents: total };
}

/**
 * Format integer cents as US currency: 123456 -> "$1,234.56", -500 -> "-$5.00".
 * @param {number} cents
 * @returns {string}
 */
function formatCents(cents) {
  const n = Math.trunc(cents);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${groupDigits(String(dollars))}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Format integer cents as a bare decimal for URLs: 123456 -> "1234.56".
 * No sign, no grouping, no currency symbol.
 * @param {number} cents
 * @returns {string}
 */
function centsToPlainDecimal(cents) {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function groupDigits(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = { parseAmount, formatCents, centsToPlainDecimal };
