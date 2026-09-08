'use strict';

// Builds a static gallery of the app's real screens, for design review or for
// showing someone what this is before they deploy it:
//
//   npm run demo            -> demo/iou-screens.html
//
// It boots the real server against a throwaway database, seeds example data,
// fetches each page over HTTP, and embeds the exact bytes that came back in
// phone-sized frames with the app's own stylesheet inlined. Nothing is
// reimplemented, so if the CSS is broken this shows it broken.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Configuration has to be in place before anything requires ./config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-demo-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'demo-only-secret';
process.env.ADMIN_USER = 'demo';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('demo-password', 10);
process.env.SITE_TITLE = process.env.SITE_TITLE || 'IOU';
process.env.OWNER_NAME = process.env.OWNER_NAME || 'DJ';
process.env.VENMO_HANDLE = process.env.VENMO_HANDLE || 'dj-saderholm';
process.env.CASHAPP_HANDLE = process.env.CASHAPP_HANDLE || 'djsaderholm';
process.env.PAYPAL_ME = process.env.PAYPAL_ME || 'djsaderholm';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://iou.example.com';
process.env.TZ = process.env.TZ || 'America/Denver';

const { app } = require('../src/server');
const db = require('../src/db');

const OUT_DIR = path.join(__dirname, '..', 'demo');
const OUT = path.join(OUT_DIR, 'iou-screens.html');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');

/** Example data. Plausible amounts, so the layout is exercised honestly. */
const SEED = [
  ['Marcus Webb', [
    ['charge', 24000, 'Snowblower, his half'],
    ['charge', 6250, 'Gas and lunch, Moab'],
    ['charge', 3418, 'Hardware store'],
    ['payment', -10000, 'Venmo'],
  ]],
  ['Aunt Rosalie', [
    ['charge', 125000, 'Airfare to Boise'],
    ['charge', 8999, 'Rental car deposit'],
    ['payment', -40000, 'Check 1204'],
  ]],
  ['Tyler', [
    ['charge', 4500, 'Concert ticket'],
    ['charge', 1875, 'Pizza'],
  ]],
  ['Priya Raman', [
    ['charge', 8000, 'Costco run'],
    ['payment', -8000, 'Cash'],
  ]],
];

/** The journey through the app, in the order someone actually walks it. */
const SCREENS = [
  { key: 'login', route: '/login', name: 'Log in', anon: true,
    note: 'The only way in. There is no registration route to find.' },
  { key: 'home', route: '/', name: 'Everyone',
    note: 'Biggest debt first. Add someone without leaving the page.' },
  { key: 'person', route: '/p/1', name: 'One running tab',
    note: 'Settle up, both entry forms, the share link, and a running balance beside every row.' },
  { key: 'undo', route: '/p/1?m=entry_deleted&undo=3', name: 'After a delete',
    note: 'Delete is soft, so the notice can hand the row straight back.' },
  { key: 'edit', route: '/p/1/entries/2/edit', name: 'Fixing a mistake',
    note: 'Amount, wording, or direction. The original date stays put.' },
  { key: 'archived', route: '/archived', name: 'Archived',
    note: 'Off the main list and out of its totals, with every entry kept. The home page keeps naming the money so it never disappears quietly.' },
  { key: 'share', route: '/t/<token>', name: 'What they see', anon: true, public: true,
    note: 'No login, no forms, no route to anyone else. Amounts prefilled into the payment buttons.' },
];

/**
 * Make a served page safe to embed: inline the stylesheet, drop assets that
 * cannot resolve outside the app, and stop links and forms from navigating the
 * frame somewhere that does not exist here.
 */
function prepare(html) {
  return html
    .replace(/<link rel="stylesheet" href="\/app\.css">/, `<style>\n${CSS}\n</style>`)
    .replace(/<link rel="(manifest|icon|apple-touch-icon)"[^>]*>\n?/g, '')
    .replace(/<script src="[^"]*"[^>]*><\/script>\n?/g, '')
    // An in-page anchor cannot navigate away from the snapshot.
    .replace(/href="\/[^"]*"/g, 'href="#"')
    // method="dialog" submits without going anywhere and needs no script, so
    // every button still looks and presses like the real thing.
    .replace(/<form method="post" action="[^"]*"/g, '<form method="dialog"')
    .replace(/<form class="([^"]*)" method="post" action="[^"]*"/g, '<form class="$1" method="dialog"');
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  db.init();

  for (const [name, entries] of SEED) {
    const id = db.createPerson(name);
    for (const [, amount, description] of entries) db.addEntry(id, amount, description);
  }
  // One archived person, still carrying a balance, so the gallery shows what
  // archiving actually does: takes them out of "Owed to you" while the home
  // page keeps naming the money underneath the list.
  const cabin = db.createPerson('Cabin Fund 2025');
  db.addEntry(cabin, 32000, 'Deposit');
  db.addEntry(cabin, -14000, 'Partial, cash');
  db.setArchived(cabin, true);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'demo', password: 'demo-password' }).toString(),
  });
  const cookie = login.headers.getSetCookie()
    .find((c) => c.startsWith('iou_session=')).split(';')[0];

  const token = db.getPerson(1).share_token;
  const urlFor = (s) => (s.key === 'share' ? `/t/${token}` : s.route);

  // The row the "after a delete" screen is about. It is really soft-deleted
  // for that one fetch and restored straight after, so the frame shows the
  // true state -- the row gone from the history and an Undo in the notice --
  // instead of a notice with nothing behind it.
  const doomed = db.listEntries(1).at(-2);

  const cards = [];
  for (const screen of SCREENS) {
    if (screen.key === 'undo') db.softDeleteEntry(1, doomed.id);

    const url = screen.key === 'undo'
      ? `/p/1?m=entry_deleted&undo=${doomed.id}`
      : urlFor(screen);
    const res = await fetch(base + url, { headers: screen.anon ? {} : { cookie } });
    const html = await res.text();

    if (screen.key === 'undo') db.restoreEntry(1, doomed.id);
    if (!res.ok) throw new Error(`${screen.key}: HTTP ${res.status}`);

    cards.push(`
      <figure class="screen">
        <figcaption>
          <p class="route">${esc(screen.route)}${screen.public ? '<span class="tag">no login</span>' : ''}</p>
          <h2>${esc(screen.name)}</h2>
          <p class="note">${esc(screen.note)}</p>
        </figcaption>
        <div class="phone">
          <iframe title="${attr(screen.name)}" loading="lazy" srcdoc="${attr(prepare(html))}"></iframe>
        </div>
      </figure>`);
  }

  server.close();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, render(cards.join('\n')));

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`${path.relative(process.cwd(), OUT)}  ${kb} KB  (${SCREENS.length} screens)`);
}

function render(cards) {
  return `<title>IOU Screens</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root {
  --ground: #e9e7e1;
  --panel: #ffffff;
  --ink: #171814;
  --muted: #6d6f65;
  --line: #d5d3ca;
  --accent: #1f6f4a;
  --accent-soft: #dfeae3;
  --bezel: #2a2c26;
  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #121310;
    --panel: #1b1d18;
    --ink: #e8e7e0;
    --muted: #979a8d;
    --line: #2b2d26;
    --accent: #55a980;
    --accent-soft: #1e2a23;
    --bezel: #050604;
  }
}

:root[data-theme="dark"] {
  --ground: #121310;
  --panel: #1b1d18;
  --ink: #e8e7e0;
  --muted: #979a8d;
  --line: #2b2d26;
  --accent: #55a980;
  --accent-soft: #1e2a23;
  --bezel: #050604;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.wrap {
  max-width: 1180px;
  margin: 0 auto;
  padding: clamp(2rem, 5vw, 3.5rem) clamp(1rem, 4vw, 2.5rem) 4rem;
  display: flex;
  flex-direction: column;
  gap: clamp(2rem, 4vw, 3rem);
}

header { display: flex; flex-direction: column; gap: .85rem; max-width: 62ch; }

.eyebrow {
  margin: 0;
  font-family: var(--mono);
  font-size: .74rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin: 0;
  font-size: clamp(1.9rem, 4.5vw, 2.75rem);
  font-weight: 700;
  letter-spacing: -.022em;
  line-height: 1.08;
  text-wrap: balance;
}

.lede { margin: 0; color: var(--muted); font-size: 1.05rem; }

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin: .35rem 0 0;
  padding: 0;
  list-style: none;
}

.facts li {
  font-family: var(--mono);
  font-size: .76rem;
  padding: .32rem .6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel);
}

.facts li.live { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(375px, 1fr));
  gap: clamp(1.75rem, 3vw, 2.75rem);
}

@media (max-width: 430px) {
  .grid { grid-template-columns: 1fr; }
}

.screen { margin: 0; display: flex; flex-direction: column; gap: .9rem; }

figcaption { display: flex; flex-direction: column; gap: .15rem; }

.route {
  display: flex;
  align-items: center;
  gap: .5rem;
  margin: 0;
  font-family: var(--mono);
  font-size: .78rem;
  color: var(--accent);
  word-break: break-all;
}

.tag {
  flex: none;
  font-size: .66rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: .1rem .42rem;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.screen h2 { margin: 0; font-size: 1.12rem; font-weight: 600; letter-spacing: -.012em; }

.note { margin: 0; color: var(--muted); font-size: .9rem; line-height: 1.45; }

/* Reads as a device without pretending to be a photograph of one. */
.phone {
  width: 100%;
  max-width: 375px;
  padding: 10px;
  background: var(--bezel);
  border-radius: 26px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .18), 0 14px 32px -18px rgba(0, 0, 0, .55);
}

.phone iframe {
  display: block;
  width: 100%;
  height: 700px;
  border: 0;
  border-radius: 17px;
  background: #f6f6f4;
}

footer {
  border-top: 1px solid var(--line);
  padding-top: 1.5rem;
  color: var(--muted);
  font-size: .88rem;
  display: flex;
  flex-direction: column;
  gap: .4rem;
  max-width: 68ch;
}

footer p { margin: 0; }
footer code { font-family: var(--mono); font-size: .84em; color: var(--ink); }

a { color: var(--accent); }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">Self-hosted &middot; Node, SQLite, no build step</p>
    <h1>Who owes you what, on one screen</h1>
    <p class="lede">
      Every frame below is the real HTML the server returned, at phone size, with
      the app's own stylesheet. Scroll inside a frame the way you would on the
      device. Nothing is a mockup and nothing has been touched up.
    </p>
    <ul class="facts">
      <li class="live">7 screens</li>
      <li>375 &times; 812</li>
      <li>light &amp; dark, from your OS</li>
      <li>links inert</li>
    </ul>
  </header>

  <div class="grid">
${cards}
  </div>

  <footer>
    <p>
      Amounts are integer cents throughout &mdash; <code>$1,240.50</code> is stored
      as <code>124050</code>, never a float. The figures here are seeded examples,
      not anyone's real balances.
    </p>
    <p>
      Frames render in whichever theme your system is set to, because the app
      ships both. Forms are live enough to press but submit nowhere.
    </p>
  </footer>
</div>
`;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* locked */ } });
