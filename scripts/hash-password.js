'use strict';

// Print a bcrypt hash for ADMIN_PASSWORD_HASH.
//   npm run hash-password -- "my password"
// With no argument it reads one line from stdin, which keeps the password out
// of shell history.

const bcrypt = require('bcryptjs');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

function emit(password) {
  if (!password) {
    console.error('No password given.');
    process.exit(1);
  }
  console.log(bcrypt.hashSync(password, ROUNDS));
}

const fromArgv = process.argv.slice(2).join(' ').trim();
if (fromArgv) {
  emit(fromArgv);
} else {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('end', () => emit(buf.split('\n')[0].trim()));
}
