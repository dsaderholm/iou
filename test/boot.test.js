'use strict';

// Startup behaviour is process-level: it ends in process.exit and log output,
// neither of which can be observed by requiring the module. So these spawn a
// real server the way the container does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const VALID_HASH = require('bcryptjs').hashSync('hunter2', 10);

let portCounter = 3200;

/**
 * Boot the server with the given env and resolve once it either exits or
 * reports that it is listening.
 */
function boot(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-boot-'));
  const port = portCounter++;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DATA_DIR: dir,
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  // The caller decides when a still-running server dies, so a test can talk to
  // it before it goes away.
  const stop = () => {
    try { child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  };

  return new Promise((resolve) => {
    const finish = (code) => resolve({ code, out, port, stop });
    // "close" rather than "exit": it fires once stdio has drained, so the log
    // output is complete by the time it is asserted on.
    child.on('close', (code) => finish(code));
    const poll = setInterval(() => {
      if (out.includes('listening on')) {
        clearInterval(poll);
        finish(null); // null means it booted and is still running
      }
    }, 50);
    setTimeout(() => { clearInterval(poll); finish(null); }, 8000);
  });
}

test('ADMIN_PASSWORD alone is enough to boot', async () => {
  const { code, out, stop } = await boot({ ADMIN_USER: 'dj', ADMIN_PASSWORD: 'hunter2' });
  stop();
  assert.equal(code, null, 'should still be running');
  assert.match(out, /listening on/);
  assert.match(out, /using ADMIN_PASSWORD/, 'and should say the password is plaintext');
});

test('ADMIN_PASSWORD_HASH alone is enough to boot, with no warning', async () => {
  const { code, out, stop } = await boot({ ADMIN_USER: 'dj', ADMIN_PASSWORD_HASH: VALID_HASH });
  stop();
  assert.equal(code, null);
  assert.match(out, /listening on/);
  assert.doesNotMatch(out, /plaintext/);
});

test('no credentials at all refuses to start', async () => {
  const { code, out } = await boot({ ADMIN_USER: 'dj' });
  assert.equal(code, 1);
  assert.match(out, /refusing to start/);
  assert.match(out, /ADMIN_PASSWORD/);
});

test('no ADMIN_USER refuses to start', async () => {
  const { code, out } = await boot({ ADMIN_PASSWORD: 'hunter2' });
  assert.equal(code, 1);
  assert.match(out, /ADMIN_USER is not set/);
});

test('a compose-mangled hash refuses to start and names the cause', async () => {
  // Exactly what docker compose leaves behind when the "$" are not doubled.
  const mangled = VALID_HASH.replace(/\$2b|\$12|\$/g, '');
  const { code, out } = await boot({ ADMIN_USER: 'dj', ADMIN_PASSWORD_HASH: mangled });
  assert.equal(code, 1);
  assert.match(out, /not a valid bcrypt hash/);
  assert.match(out, /ate the dollar signs/);
  assert.match(out, /ADMIN_PASSWORD instead/, 'should point at the easier way out');
});

test('the hash wins when both are set', async () => {
  const { code, out, port, stop } = await boot({
    ADMIN_USER: 'dj',
    ADMIN_PASSWORD: 'this-one-is-ignored',
    ADMIN_PASSWORD_HASH: VALID_HASH,
  });
  assert.equal(code, null);
  assert.doesNotMatch(out, /plaintext/);

  const form = (password) => fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'dj', password }).toString(),
  });

  try {
    assert.equal((await form('hunter2')).status, 303, 'the hash password works');
    assert.equal((await form('this-one-is-ignored')).status, 401, 'the plaintext one does not');
  } finally {
    stop();
  }
});
