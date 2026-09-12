'use strict';

const config = require('./config');
const { formatCents, centsToPlainDecimal } = require('./money');

/* ----------------------------------------------------------------- escaping */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape untrusted text for HTML text nodes and double-quoted attributes. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/* -------------------------------------------------------------------- dates */

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const DATE_FMT_OLD = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
});

/** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; render it in the server's zone. */
function parseSqliteDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(s) {
  const d = parseSqliteDate(s);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? DATE_FMT.format(d) : DATE_FMT_OLD.format(d);
}

function isoDate(s) {
  const d = parseSqliteDate(s);
  return d ? d.toISOString() : '';
}

/* ------------------------------------------------------------------- layout */

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {boolean} [opts.chrome]     render the admin header
 * @param {boolean} [opts.installable] link the web app manifest
 * @param {string}  [opts.scriptSrc]  external script, loaded deferred
 */
function layout({ title, body, chrome = false, installable = false, scriptSrc = '' }) {
  // The manifest is only linked on admin pages. A share page is opened by
  // someone who cannot use the app, and offering to install it would just
  // give them a home screen icon leading to a login form.
  const install = installable
    ? `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f6f4a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${esc(config.siteTitle)}">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
${install}
${scriptSrc ? `<script src="${esc(scriptSrc)}" defer></script>` : ''}
</head>
<body>
${chrome ? adminHeader() : ''}
<main>
${body}
</main>
</body>
</html>`;
}

function adminHeader() {
  return `<header class="bar">
  <a class="bar-home" href="/">${esc(config.siteTitle)}</a>
  <nav>
    <a href="/activity">Activity</a>
    <a href="/export.csv">CSV</a>
    <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>
  </nav>
</header>`;
}

/**
 * A div, not a p: the notice can carry an Undo form, and a <form> start tag
 * implicitly closes an open <p>, which would leave the button stranded outside
 * the box it is supposed to sit in.
 */
function flash(kind, message, extra = '') {
  if (!message) return '';
  return `<div class="flash flash-${esc(kind)}" role="status"><span>${esc(message)}</span>${extra}</div>`;
}

/** Balance styled by direction: owed (positive), credit (negative), settled. */
function balanceClass(cents) {
  if (cents > 0) return 'owed';
  if (cents < 0) return 'credit';
  return 'settled';
}

/* -------------------------------------------------------------------- login */

function loginPage({ error, nextUrl }) {
  const body = `<div class="card login">
  <h1>${esc(config.siteTitle)}</h1>
  ${flash('error', error)}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${esc(nextUrl || '/')}">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username"
           autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button class="primary" type="submit">Log in</button>
  </form>
</div>`;
  return layout({ title: config.siteTitle + ' - Log in', body, installable: true });
}

/* --------------------------------------------------------------- admin home */

function homePage({ people, archived, notice, error }) {
  const net = people.reduce((sum, p) => sum + p.balance, 0);
  const owedTotal = people.reduce((sum, p) => sum + (p.balance > 0 ? p.balance : 0), 0);

  const rows = people.length === 0
    ? '<p class="empty">No one yet. Add your first person below.</p>'
    : `<ul class="people">${people.map((p) => `
      <li>
        <a href="/p/${p.id}">
          <span class="person-name">${esc(p.name)}</span>
          <span class="amount ${balanceClass(p.balance)}">${esc(formatCents(p.balance))}</span>
        </a>
      </li>`).join('')}</ul>`;

  // "Owed to you" counts active people only, so any money owed by an archived
  // person has to be named here. Otherwise archiving looks like tidying while
  // quietly shrinking the one number this page exists to show.
  const archivedLink = archived && archived.count > 0
    ? `<p class="archived-link">
    <a href="/archived">Archived (${archived.count})</a>${archived.owed > 0
      ? `<span class="archived-owed">${esc(formatCents(archived.owed))} owed, not counted above</span>`
      : ''}
  </p>`
    : '';

  const body = `
${flash('notice', notice)}
${flash('error', error)}
<section class="totals">
  <div><span class="totals-label">Owed to you</span><span class="amount owed">${esc(formatCents(owedTotal))}</span></div>
  <div><span class="totals-label">Net</span><span class="amount ${balanceClass(net)}">${esc(formatCents(net))}</span></div>
</section>

${rows}

<form class="card add-person" method="post" action="/people">
  <label for="name">Add a person</label>
  <div class="row">
    <input id="name" name="name" type="text" placeholder="Name" required
           autocapitalize="words" autocomplete="off" enterkeyhint="done" maxlength="80">
    <button class="primary" type="submit">Add</button>
  </div>
</form>

${archivedLink}
<p class="archived-link"><a href="/export.db">Download database backup</a></p>
<form method="post" action="/logout-all" class="archived-link"
      data-confirm="Log out every device, including this one?">
  <button class="linkish" type="submit">Log out of all devices</button>
</form>`;

  return layout({
    title: config.siteTitle,
    body,
    chrome: true,
    installable: true,
    scriptSrc: '/person.js',
  });
}

/* ---------------------------------------------------------------- activity */

/**
 * Everything recent, across everyone. The per-person history cannot show you a
 * charge that landed on the wrong tab, because you would have to already
 * suspect it to go looking.
 */
function activityPage({ entries, notice, error }) {
  const rows = entries.length === 0
    ? '<p class="empty">Nothing recorded yet.</p>'
    : `<ul class="entries activity">${entries.map((e) => `
      <li>
        <div class="entry-main">
          <a class="entry-who" href="/p/${e.person_id}">${esc(e.person_name)}</a>
          <span class="amount ${e.amount < 0 ? 'credit' : 'owed'}">${esc(formatCents(e.amount))}</span>
        </div>
        <div class="entry-meta">
          <span class="entry-desc">${esc(e.description || (e.amount < 0 ? 'Payment' : 'Charge'))}</span>
          <time datetime="${esc(isoDate(e.created_at))}">${esc(formatDate(e.created_at))}</time>
          ${e.archived_at ? '<span class="badge">archived</span>' : ''}
        </div>
      </li>`).join('')}</ul>`;

  const body = `
<p class="back"><a href="/">&larr; All people</a></p>
${flash('notice', notice)}
${flash('error', error)}
<section class="headline">
  <h1>Activity</h1>
  <p class="headline-sub">The last ${entries.length} entries, newest first, across everyone.
     Tap a name to open that tab.</p>
</section>
${rows}`;

  return layout({ title: 'Activity - ' + config.siteTitle, body, chrome: true, installable: true });
}

/* ------------------------------------------------------------ archived list */

function archivedPage({ people, notice, error }) {
  const total = people.reduce((sum, p) => sum + p.balance, 0);

  const rows = people.length === 0
    ? '<p class="empty">Nobody is archived.</p>'
    : `<ul class="people">${people.map((p) => `
      <li>
        <a href="/p/${p.id}">
          <span class="person-name">${esc(p.name)}</span>
          <span class="amount ${balanceClass(p.balance)}">${esc(formatCents(p.balance))}</span>
        </a>
      </li>`).join('')}</ul>`;

  const body = `
<p class="back"><a href="/">&larr; All people</a></p>
${flash('notice', notice)}
${flash('error', error)}
<section class="headline">
  <h1>Archived</h1>
  <p class="headline-sub">Hidden from the main list and left out of its totals.
     Their share links still work.</p>
</section>
${people.length ? `<section class="totals">
  <div><span class="totals-label">Archived balance</span><span class="amount ${balanceClass(total)}">${esc(formatCents(total))}</span></div>
</section>` : ''}
${rows}`;

  return layout({ title: 'Archived - ' + config.siteTitle, body, chrome: true, installable: true });
}

/* ------------------------------------------------------------ person detail */

function personPage({
  person, entries, balance, shareUrl, chargeSuggestions, paymentSuggestions,
  notice, error, undoEntryId,
}) {
  const newest = entries.slice().reverse();
  const archived = Boolean(person.archived_at);

  const history = newest.length === 0
    ? '<p class="empty">No entries yet.</p>'
    : `<ul class="entries">${newest.map((e) => `
      <li>
        <div class="entry-main">
          <span class="entry-desc">${esc(e.description || (e.amount < 0 ? 'Payment' : 'Charge'))}</span>
          <span class="amount ${e.amount < 0 ? 'credit' : 'owed'}">${esc(formatCents(e.amount))}</span>
        </div>
        <div class="entry-meta">
          <time datetime="${esc(isoDate(e.created_at))}">${esc(formatDate(e.created_at))}</time>
          <span class="running">balance ${esc(formatCents(e.running_balance))}</span>
          <a class="entry-action" href="/p/${person.id}/entries/${e.id}/edit">Edit</a>
          <form method="post" action="/p/${person.id}/entries/${e.id}/delete" class="inline-form">
            <button class="linkish danger" type="submit">Delete</button>
          </form>
        </div>
      </li>`).join('')}</ul>`;

  // Deleting is a soft delete, so the flash can offer the row straight back
  // rather than making a mis-tap permanent.
  const undo = undoEntryId
    ? ` <form method="post" action="/p/${person.id}/entries/${undoEntryId}/restore" class="inline-form">
        <button class="linkish" type="submit">Undo</button>
      </form>`
    : '';

  const settle = balance > 0 ? `
<form method="post" action="/p/${person.id}/settle" class="settle-form"
      data-confirm="Record a ${esc(formatCents(balance))} payment and clear this tab?">
  <button class="secondary settle" type="submit">Settle up &mdash; record ${esc(formatCents(balance))}</button>
</form>` : '';

  const body = `
<p class="back"><a href="${archived ? '/archived' : '/'}">&larr; ${archived ? 'Archived' : 'All people'}</a></p>
${flash('notice', notice, undo)}
${flash('error', error)}

<section class="headline">
  <h1>${esc(person.name)}${archived ? ' <span class="badge">archived</span>' : ''}</h1>
  <p class="amount big ${balanceClass(balance)}">${esc(formatCents(balance))}</p>
  <p class="headline-sub">${balance > 0 ? 'owes you' : balance < 0 ? 'you owe them' : 'settled up'}</p>
</section>

${settle}

<form class="card entry-form" method="post" action="/p/${person.id}/entries">
  <input type="hidden" name="kind" value="charge">
  <h2>Add charge</h2>
  <div class="row">
    ${amountInput('charge-amount', true)}
    ${descriptionInput('What for?', 'charge-history')}
  </div>
  <button class="primary" type="submit">Add charge</button>
</form>

<form class="card entry-form" method="post" action="/p/${person.id}/entries">
  <input type="hidden" name="kind" value="payment">
  <h2>Record payment</h2>
  <div class="row">
    ${amountInput('payment-amount', false)}
    ${descriptionInput('Note (optional)', 'payment-history')}
  </div>
  <button class="secondary" type="submit">Record payment</button>
</form>

${datalist('charge-history', chargeSuggestions)}
${datalist('payment-history', paymentSuggestions)}

<section class="card share">
  <h2>Share link</h2>
  <p class="share-url" id="share-url">${esc(shareUrl)}</p>
  <div class="row">
    <button class="primary" type="button" id="copy-btn" data-url="${esc(shareUrl)}">Copy link</button>
    <button class="secondary" type="button" id="share-btn" hidden
            data-url="${esc(shareUrl)}" data-name="${esc(person.name)}">Share</button>
    <a class="button secondary" href="${esc(shareUrl)}" target="_blank" rel="noopener">Open</a>
  </div>
  <form method="post" action="/p/${person.id}/token" class="inline-form"
        data-confirm="Regenerate the link? The old one stops working.">
    <button class="linkish danger" type="submit">Regenerate link</button>
  </form>
</section>

<section class="history">
  <h2>History</h2>
  ${history}
</section>

<section class="card danger-zone">
  <form method="post" action="/p/${person.id}/rename" class="rename">
    <label for="rename">Rename</label>
    <div class="row">
      <input id="rename" name="name" type="text" value="${esc(person.name)}" required
             maxlength="80" autocapitalize="words" autocomplete="off">
      <button class="secondary" type="submit">Save</button>
    </div>
  </form>
  <div class="danger-actions">
    <form method="post" action="/p/${person.id}/${archived ? 'unarchive' : 'archive'}" class="inline-form"${
      !archived && balance !== 0
        ? `\n          data-confirm="${esc(person.name)} still has a balance of ${esc(formatCents(balance))}. Archiving takes it out of your Owed to you total. Archive anyway?"`
        : ''}>
      <button class="linkish" type="submit">${archived ? 'Unarchive' : 'Archive'}</button>
    </form>
    <form method="post" action="/p/${person.id}/delete" class="inline-form"
          data-confirm="Delete this person and every entry permanently? Archive keeps the history; this does not.">
      <button class="linkish danger" type="submit">Delete permanently</button>
    </form>
  </div>
</section>`;

  return layout({
    title: person.name + ' - ' + config.siteTitle,
    body,
    chrome: true,
    installable: true,
    scriptSrc: '/person.js',
  });
}

/* -------------------------------------------------------------- entry edit */

function editEntryPage({ person, entry, error }) {
  const isPayment = entry.amount < 0;
  const amount = centsToPlainDecimal(entry.amount);
  const onDate = localDateInputValue(entry.created_at);

  const body = `
<p class="back"><a href="/p/${person.id}">&larr; ${esc(person.name)}</a></p>
${flash('error', error)}

<section class="headline">
  <h1>Edit entry</h1>
  <p class="headline-sub">Recorded ${esc(formatDate(entry.created_at))}.</p>
</section>

<form class="card entry-form" method="post" action="/p/${person.id}/entries/${entry.id}/edit">
  <label for="edit-amount">Amount</label>
  <div class="row">
    <input id="edit-amount" class="amount-input" name="amount" type="text"
           inputmode="decimal" value="${esc(amount)}" required
           autocomplete="off" autocorrect="off" spellcheck="false" autofocus>
  </div>

  <label for="edit-description">Description</label>
  <input id="edit-description" name="description" type="text" maxlength="200"
         value="${esc(entry.description)}" autocapitalize="sentences" autocomplete="off">

  <label for="edit-date">Date</label>
  <input id="edit-date" name="date" type="date" value="${esc(onDate)}"
         max="${esc(localDateInputValue(new Date().toISOString().replace('T', ' ').slice(0, 19)))}">

  <fieldset class="kind">
    <legend>Type</legend>
    <label><input type="radio" name="kind" value="charge"${isPayment ? '' : ' checked'}> Charge (they owe more)</label>
    <label><input type="radio" name="kind" value="payment"${isPayment ? ' checked' : ''}> Payment (they paid you)</label>
  </fieldset>

  <button class="primary" type="submit">Save changes</button>
  <a class="button secondary" href="/p/${person.id}">Cancel</a>
</form>`;

  return layout({
    title: 'Edit entry - ' + config.siteTitle,
    body,
    chrome: true,
    installable: true,
  });
}

/**
 * The amount field. inputmode="decimal" is what makes Android open the number
 * pad; the type stays "text" so a comma or a stray "$" is not silently
 * discarded by the browser before the server ever sees it.
 */
function amountInput(id, autofocus) {
  return `<input id="${esc(id)}" class="amount-input" name="amount" type="text"
           inputmode="decimal" placeholder="0.00" required
           autocomplete="off" autocorrect="off" spellcheck="false"
           enterkeyhint="next"${autofocus ? ' autofocus' : ''}>`;
}

function descriptionInput(placeholder, listId) {
  return `<input name="description" type="text" placeholder="${esc(placeholder)}" maxlength="200"
           list="${esc(listId)}" autocapitalize="sentences" autocomplete="off" enterkeyhint="done">`;
}

/** Past descriptions, so a repeat charge is a tap instead of retyping. */
function datalist(id, values) {
  if (!values || values.length === 0) return '';
  return `<datalist id="${esc(id)}">${
    values.map((v) => `<option value="${esc(v)}"></option>`).join('')
  }</datalist>`;
}

/* --------------------------------------------------------------- share page */

/** Payment links for this balance, in a stable order. Empty when nothing is owed. */
function paymentLinks(balance, personName) {
  if (balance <= 0) return [];
  const amount = centsToPlainDecimal(balance);
  const note = 'Balance for ' + personName;
  const links = [];

  if (config.venmoHandle) {
    links.push({
      label: 'Pay with Venmo',
      // txn=pay, not txn=charge. On Venmo, "charge" opens a request for money
      // FROM the profile in the link -- so a charge link on this page would ask
      // the person who is owed to pay the person who owes them. The viewer here
      // is the debtor, and the button says Pay.
      href: 'https://venmo.com/' + encodeURIComponent(config.venmoHandle) +
            '?txn=pay&amount=' + encodeURIComponent(amount) +
            '&note=' + encodeURIComponent(note),
      cls: 'venmo',
    });
  }
  if (config.cashappHandle) {
    links.push({
      label: 'Pay with Cash App',
      href: 'https://cash.app/$' + encodeURIComponent(config.cashappHandle) + '/' + amount,
      cls: 'cashapp',
    });
  }
  if (config.paypalMe) {
    links.push({
      label: 'Pay with PayPal',
      href: 'https://paypal.me/' + encodeURIComponent(config.paypalMe) + '/' + amount + 'USD',
      cls: 'paypal',
    });
  }
  return links;
}

function sharePage({ person, entries, balance }) {
  const newest = entries.slice().reverse();
  const links = paymentLinks(balance, person.name);

  const history = newest.length === 0
    ? '<p class="empty">No entries yet.</p>'
    : `<ul class="entries public">${newest.map((e) => `
      <li>
        <div class="entry-main">
          <span class="entry-desc">${esc(e.description || (e.amount < 0 ? 'Payment' : 'Charge'))}</span>
          <span class="amount ${e.amount < 0 ? 'credit' : 'owed'}">${esc(formatCents(e.amount))}</span>
        </div>
        <div class="entry-meta">
          <time datetime="${esc(isoDate(e.created_at))}">${esc(formatDate(e.created_at))}</time>
        </div>
      </li>`).join('')}</ul>`;

  const owedTo = config.ownerName ? ' to ' + esc(config.ownerName) : '';
  const summary = balance > 0
    ? `<p class="headline-sub">you owe${owedTo}</p>`
    : balance < 0
      ? '<p class="headline-sub">credit on your account</p>'
      : '<p class="headline-sub">all settled up</p>';

  const payBlock = links.length === 0 ? '' : `
<section class="pay">
  ${links.map((l) => `<a class="button pay-link ${l.cls}" href="${esc(l.href)}" rel="noopener nofollow">${esc(l.label)}</a>`).join('')}
</section>`;

  const body = `
<section class="headline">
  <h1>${esc(person.name)}</h1>
  <p class="amount big ${balanceClass(balance)}">${esc(formatCents(balance))}</p>
  ${summary}
</section>
${payBlock}
<section class="history">
  <h2>History</h2>
  ${history}
</section>
<p class="fineprint">Anyone with this link can see this page. It is not listed anywhere.</p>`;

  return layout({ title: person.name, body });
}

/* -------------------------------------------------------------------- error */

function notFoundPage() {
  return layout({
    title: 'Not found',
    body: '<section class="headline"><h1>Not found</h1>' +
          '<p class="headline-sub">Nothing lives at this address.</p></section>',
  });
}

function errorPage() {
  return layout({
    title: 'Error',
    body: '<section class="headline"><h1>Something went wrong</h1>' +
          '<p class="headline-sub">Try again.</p></section>',
  });
}

/** An entry's date as the server's local calendar day, for <input type="date">. */
function localDateInputValue(sqliteDate) {
  const d = parseSqliteDate(sqliteDate) || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  esc,
  layout,
  formatDate,
  localDateInputValue,
  loginPage,
  homePage,
  activityPage,
  archivedPage,
  personPage,
  editEntryPage,
  sharePage,
  paymentLinks,
  notFoundPage,
  errorPage,
};
