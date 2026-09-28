'use strict';

/**
 * T7 boot guards, in clean child processes.
 *
 * `src/config/env.js` throws at require time, so a single process can only ever
 * prove one of these outcomes. Each case therefore runs in its own `node -e`
 * with its own environment, which is also the only honest way to test a guard:
 * running them in one process would prove that the FIRST throw happened, not
 * that each condition is caught by the right one.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SECRET = 'openssl-rand-hex-32-placeholder-value-000000';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function boot(env) {
  try {
    execFileSync(process.execPath, ['-e', "require('./src/config/env')"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { booted: true, output: '' };
  } catch (e) {
    return { booted: false, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const prod = { NODE_ENV: 'production', JWT_SECRET: SECRET, ENCRYPTION_KEY: SECRET, DATABASE_URL: 'postgresql://u:p@real-host:5432/db' };

console.log('\nDevelopment still boots with nothing set');
const dev = boot({ NODE_ENV: 'development', JWT_SECRET: '', ENCRYPTION_KEY: '', DATABASE_URL: '', CORS_ORIGIN: '' });
check('development boots on the fallbacks', dev.booted, dev.output.slice(0, 200));

console.log('\nCORS guard (M1)');
const wildcard = boot({ ...prod, CORS_ORIGIN: '*' });
check('production refuses to start on CORS_ORIGIN=*', !wildcard.booted, 'it booted');
check('the message names ALLOW_ANY_ORIGIN', /ALLOW_ANY_ORIGIN/.test(wildcard.output), wildcard.output.slice(0, 200));

const allowed = boot({ ...prod, CORS_ORIGIN: 'https://app.example.com', ALLOW_ANY_ORIGIN: '' });
check('a named origin boots', allowed.booted, allowed.output.slice(0, 200));

const opted = boot({ ...prod, CORS_ORIGIN: '*', ALLOW_ANY_ORIGIN: 'true' });
check('ALLOW_ANY_ORIGIN=true permits the wildcard deliberately', opted.booted, opted.output.slice(0, 200));

console.log('\nThe secrets guard still fires alongside the new one (T1 unchanged)');
const noSecret = boot({ NODE_ENV: 'production', JWT_SECRET: '', ENCRYPTION_KEY: SECRET, DATABASE_URL: 'postgresql://u:p@h:5432/d' });
check('production refuses without JWT_SECRET', !noSecret.booted, 'it booted');
check('the secrets message is the old one, not the CORS one',
  /Refusing to start in production/.test(noSecret.output) && !/ALLOW_ANY_ORIGIN/.test(noSecret.output),
  noSecret.output.slice(0, 200));

const defaulted = boot({ ...prod, JWT_SECRET: 'default_jwt_secret_for_development' });
check('production refuses the published JWT default', !defaulted.booted, 'it booted');

console.log('\nTRUST_PROXY (T6, re-checked after the env.js edits)');
// Empty resolves to the DEFAULT of 1, not null: the user confirmed one proxy
// (Render) in front, and `null` would put every production caller in one shared
// bucket. Only an explicit 0 disables it.
for (const [value, expected] of [['', 1], ['0', null], ['-1', null], ['true', null], ['abc', null], ['1', 1], ['2', 2]]) {
  const r = boot({ NODE_ENV: 'development', TRUST_PROXY: value, CORS_ORIGIN: '' });
  if (!r.booted) { check(`TRUST_PROXY="${value}" resolves`, false, r.output.slice(0, 120)); continue; }
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/config/env').trustProxy))"], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', TRUST_PROXY: value }, encoding: 'utf8',
  });
  check(`TRUST_PROXY="${value}" -> ${expected}`, String(Number(out)) === String(expected) || (expected === null && out === 'null'),
    `got ${out}`);
}

console.log('\nJWT issuer/audience are not env-overridable');
const spoof = boot({ ...prod, JWT_ISSUER: 'attacker', JWT_AUDIENCE: 'attacker' });
if (!spoof.booted) { check('the app boots with JWT_ISSUER spoofed in the env', false, spoof.output.slice(0, 200)); }
else {
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/config/env').JWT_ISSUER)"], {
    cwd: ROOT, env: { ...process.env, ...prod, JWT_ISSUER: 'attacker' }, encoding: 'utf8',
  });
  check('a spoofed JWT_ISSUER in the environment is ignored', out === 'mcp-rag-server', `got ${out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail === 0 ? 0 : 1);
