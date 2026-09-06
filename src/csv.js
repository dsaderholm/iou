'use strict';

const { centsToPlainDecimal } = require('./money');

const COLUMNS = [
  'person_id',
  'person_name',
  'entry_id',
  'created_at_utc',
  'amount_cents',
  'amount_usd',
  'kind',
  'description',
];

/** RFC 4180 field: always quoted, internal quotes doubled. */
function field(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Render every entry as CSV. amount_cents is the authoritative integer value;
 * amount_usd is a signed convenience column for spreadsheets.
 */
function entriesToCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    const usd = (row.amount < 0 ? '-' : '') + centsToPlainDecimal(row.amount);
    lines.push([
      field(row.person_id),
      field(row.person_name),
      field(row.id),
      field(row.created_at),
      field(row.amount),
      field(usd),
      field(row.amount < 0 ? 'payment' : 'charge'),
      field(row.description),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { entriesToCsv, COLUMNS };
