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
 * @param {string}  [opts.scriptSrc]  external script, loaded deferred
 */
function layout({ title, body, chrome = false, scriptSrc = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:,">
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
    <a href="/export.csv">CSV</a>
    <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>
  </nav>
</header>`;
}

function flash(kind, message) {
  if (!message) return '';
  return `<p class="flash flash-${esc(kind)}" role="status">${esc(message)}</p>`;
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
  return layout({ title: config.siteTitle + ' - Log in', body });
}

/* --------------------------------------------------------------- admin home */

function homePage({ people, notice, error }) {
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
</form>`;

  return layout({ title: config.siteTitle, body, chrome: true });
}

/* ------------------------------------------------------------ person detail */

function personPage({ person, entries, balance, shareUrl, notice, error }) {
  const newest = entries.slice().reverse();

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
          <form method="post" action="/p/${person.id}/entries/${e.id}/delete" class="inline-form"
                data-confirm="Delete this entry?">
            <button class="linkish danger" type="submit">Delete</button>
          </form>
        </div>
      </li>`).join('')}</ul>`;

  const body = `
<p class="back"><a href="/">&larr; All people</a></p>
${flash('notice', notice)}
${flash('error', error)}

<section class="headline">
  <h1>${esc(person.name)}</h1>
  <p class="amount big ${balanceClass(balance)}">${esc(formatCents(balance))}</p>
  <p class="headline-sub">${balance > 0 ? 'owes you' : balance < 0 ? 'you owe them' : 'settled up'}</p>
</section>

<form class="card entry-form" method="post" action="/p/${person.id}/entries">
  <input type="hidden" name="kind" value="charge">
  <h2>Add charge</h2>
  <div class="row">
    ${amountInput('charge-amount', true)}
    <input name="description" type="text" placeholder="What for?" maxlength="200"
           autocapitalize="sentences" autocomplete="off" enterkeyhint="done">
  </div>
  <button class="primary" type="submit">Add charge</button>
</form>

<form class="card entry-form" method="post" action="/p/${person.id}/entries">
  <input type="hidden" name="kind" value="payment">
  <h2>Record payment</h2>
  <div class="row">
    ${amountInput('payment-amount', false)}
    <input name="description" type="text" placeholder="Note (optional)" maxlength="200"
           autocapitalize="sentences" autocomplete="off" enterkeyhint="done">
  </div>
  <button class="secondary" type="submit">Record payment</button>
</form>

<section class="card share">
  <h2>Share link</h2>
  <p class="share-url" id="share-url">${esc(shareUrl)}</p>
  <div class="row">
    <button class="primary" type="button" id="copy-btn" data-url="${esc(shareUrl)}">Copy link</button>
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
  <form method="post" action="/p/${person.id}/delete" class="inline-form"
        data-confirm="Delete this person and all their entries? This cannot be undone.">
    <button class="linkish danger" type="submit">Delete person</button>
  </form>
</section>`;

  return layout({
    title: person.name + ' - ' + config.siteTitle,
    body,
    chrome: true,
    scriptSrc: '/person.js',
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
      href: 'https://venmo.com/' + encodeURIComponent(config.venmoHandle) +
            '?txn=charge&amount=' + encodeURIComponent(amount) +
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

module.exports = {
  esc,
  layout,
  formatDate,
  loginPage,
  homePage,
  personPage,
  sharePage,
  paymentLinks,
  notFoundPage,
  errorPage,
};
