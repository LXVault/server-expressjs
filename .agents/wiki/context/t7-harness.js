'use strict';

/**
 * T7 verification harness — error disclosure, enumeration, JWT pinning, logout.
 *
 * Everything here drives the REAL application: the real app.js, the real
 * middleware, the real controllers. Only the pg pool is stubbed, because there
 * is no PostgreSQL in this environment.
 *
 * The stub is table-aware on purpose. A stub that answers every query with the
 * same canned rows makes every authorization and enumeration test pass
 * vacuously, so the pool dispatches on the SQL text and holds real user rows,
 * real token versions and a real "does this account exist" distinction.
 */

const http = require('http');
const path = require('path');

// The harness lives under .agents/, so every application path is resolved
// against the repository root rather than against this file.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = (p) => require(path.join(ROOT, p));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- Users table -----------------------------------------------------------

const U = {
  owner: { id: '11111111-1111-4111-8111-111111111111', username: 'owner', email: 'owner@example.com', token_version: 3 },
  editor: { id: '22222222-2222-4222-8222-222222222222', username: 'editor', email: 'editor@example.com', token_version: 0 },
};

let users = [U.owner, U.editor];

// A project the owner can administer, so the member-add route is reachable
// rather than stopping at the access check.
const PROJECT = { id: '44444444-4444-4444-8444-444444444444' };
// A realistic bcrypt hash so the timing comparison is against real work.
const REAL_HASH = require('bcryptjs').hashSync('correct-password', 10);
users[0] = { ...U.owner, password_hash: REAL_HASH };
users[1] = { ...U.editor, password_hash: require('bcryptjs').hashSync('other-password', 10) };

let logoutBumps = 0;

const pool = {
  async query(sql, params) {
    const text = String(sql);
    if (process.env.T7_TRACE) {
      console.log(`  [sql] ${text.replace(/\s+/g, ' ').trim().slice(0, 90)} | ${JSON.stringify(params)}`);
    }
    if (/SELECT id, username, token_version FROM users WHERE id/.test(text)) {
      const row = users.find((u) => u.id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // profileController selects a different column list for the same row.
    if (/SELECT id, username, email, created_at, updated_at/.test(text)) {
      const row = users.find((u) => u.id === params[0]);
      const { id, username, email } = row || {};
      return {
        rows: row ? [{ id, username, email, created_at: null, updated_at: null }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (/SELECT id, username, email, password_hash, token_version/.test(text)) {
      const row = users.find((u) => u.email === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (/INSERT INTO users/.test(text)) {
      const [username, email] = params;
      if (users.some((u) => u.username === username || u.email === email)) {
        const err = new Error('duplicate key value violates unique constraint "users_email_key"');
        err.code = '23505';
        throw err;
      }
      const row = {
        id: '33333333-3333-4333-8333-333333333333',
        username, email, token_version: 0,
      };
      users.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/UPDATE users SET token_version = token_version \+ 1/.test(text)) {
      const row = users.find((u) => u.id === params[0]);
      if (row) { row.token_version += 1; logoutBumps += 1; }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (/SELECT id, username, email FROM users WHERE username/.test(text)) {
      const row = users.find((u) => u.username === params[0] || u.email === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // A project the caller owns, so loadAccess succeeds and the member-add
    // route actually reaches its user lookup. Without this the enumeration
    // branch is never entered and the test passes for the wrong reason.
    if (/SELECT d\.\*/.test(text) || /member_role/.test(text)) {
      return {
        rows: [{
          id: PROJECT.id,
          owner_id: U.owner.id,
          title: 'Probe project',
          summary: null,
          embedding_model: 'openai/text-embedding-3-small',
          is_owner: true,
          member_role: null,
        }],
        rowCount: 1,
      };
    }

    // A deliberately leaky error, standing in for a real pg failure. This is
    // the `documents` listing, which is an aggregate with no `member_role` and
    // no `SELECT d.*`, so it falls through to here. Both assertions below are
    // about the message this throws, not about the query.
    if (/FROM documents/.test(text)) {
      const err = new Error('password authentication failed for user "mcp_user"');
      err.code = '28P01';
      throw err;
    }

    return { rows: [], rowCount: 0 };
  },
  async connect() {
    return { query: pool.query, release() {} };
  },
};

require.cache[require.resolve(path.join(ROOT, 'src/config/db'))] = {
  id: path.join(ROOT, 'src/config/db'),
  filename: path.join(ROOT, 'src/config/db'),
  loaded: true,
  exports: { pool, query: pool.query, healthCheck: async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432'); } },
};

const config = APP('src/config/env');
const app = APP('src/app');
const { signToken } = APP('src/utils/jwt');
const jwt = require('jsonwebtoken');

// --- HTTP ------------------------------------------------------------------

let base;
function req(method, path, { body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ---------------------------------------------------------------- M2
  console.log('\nM2 — security headers and framework disclosure');
  const ping = await req('GET', '/api/ping');
  eq('X-Powered-By removed', ping.headers['x-powered-by'], undefined);
  check('X-Content-Type-Options: nosniff', ping.headers['x-content-type-options'] === 'nosniff',
    `got ${ping.headers['x-content-type-options']}`);
  check('X-Frame-Options set', Boolean(ping.headers['x-frame-options']),
    `got ${ping.headers['x-frame-options']}`);
  check('Content-Security-Policy set', Boolean(ping.headers['content-security-policy']),
    'absent');
  check('Referrer-Policy set', Boolean(ping.headers['referrer-policy']), 'absent');

  // ---------------------------------------------------------------- M3
  console.log('\nM3 — /health leaks nothing about the database');
  const health = await req('GET', '/health');
  eq('health status is 503 when the check throws', health.status, 503);
  const healthText = JSON.stringify(health.body);
  check('no pg message in the body', !/mcp_user|password authentication|ECONNREFUSED|10\.0\.0\.5/.test(healthText),
    healthText);
  check('no db field', health.body.db === undefined, JSON.stringify(health.body));
  eq('body is the fixed degraded status', health.body.status, 'degraded');

  // ---------------------------------------------------------------- M4
  console.log('\nM4 — 5xx does not forward the driver message in production');
  const prevEnv = config.nodeEnv;
  config.nodeEnv = 'production';
  // Any authenticated route that hits the failing stub. requireAuth passes for
  // a real user; the controller's query then throws the pg error.
  const token = signToken({ ...U.owner, token_version: U.owner.token_version });
  const leaky = await req('GET', '/api/documents', { token });
  eq('request reached the controller', leaky.status, 500);
  const leakyText = leaky.body ? leaky.body.error : '';
  eq('5xx body is the fixed string', leakyText, 'Internal Server Error');
  check('no pg text anywhere in the response', !/mcp_user|password authentication/.test(leaky.raw), leaky.raw);
  config.nodeEnv = prevEnv;

  console.log('\nM4b — 4xx keeps its authored message in production too');
  config.nodeEnv = 'production';
  const badId = await req('GET', '/api/documents/not-a-uuid', { token });
  eq('4xx status preserved', badId.status, 400);
  eq('4xx message preserved', badId.body.error, 'Invalid document id');
  check('no pg text in a 4xx', !/password authentication/.test(badId.raw), badId.raw);
  config.nodeEnv = prevEnv;

  // ---------------------------------------------------------------- M11
  console.log('\nM11 — JWT verification is pinned');
  const good = signToken({ ...U.owner, token_version: U.owner.token_version });
  const authed = await req('GET', '/api/profile', { token: good });
  eq('a correctly signed token still works', authed.status, 200);

  const wrongIssuer = jwt.sign(
    { sub: U.owner.id, username: U.owner.username, ver: U.owner.token_version },
    config.jwtSecret,
    { expiresIn: '7d', algorithm: 'HS256', issuer: 'some-other-service', audience: config.JWT_AUDIENCE }
  );
  const badIssuer = await req('GET', '/api/profile', { token: wrongIssuer });
  eq('a token from another issuer is refused', badIssuer.status, 401);

  const wrongAudience = jwt.sign(
    { sub: U.owner.id, username: U.owner.username, ver: U.owner.token_version },
    config.jwtSecret,
    { expiresIn: '7d', algorithm: 'HS256', issuer: config.JWT_ISSUER, audience: 'another-api' }
  );
  const badAudience = await req('GET', '/api/profile', { token: wrongAudience });
  eq('a token for another audience is refused', badAudience.status, 401);

  const noneAlg = jwt.sign(
    { sub: U.owner.id, username: U.owner.username, ver: U.owner.token_version },
    '',
    { algorithm: 'none' }
  );
  const algNone = await req('GET', '/api/profile', { token: noneAlg });
  eq('alg:none is refused', algNone.status, 401);

  // A token minted before `ver` existed carries no such claim. It must read as
  // version 0, so it works for a user still at version 0 — otherwise adding
  // logout would sign every signed-in user out on deploy.
  const noVer = jwt.sign(
    { sub: U.editor.id, username: U.editor.username },
    config.jwtSecret,
    { expiresIn: '7d', algorithm: 'HS256', issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }
  );
  const legacy = await req('GET', '/api/profile', { token: noVer });
  check('a pre-existing token (no ver claim) works for a version-0 user',
    legacy.status === 200, `got ${legacy.status}`);

  // And it must NOT work for a user who has since logged out, even though the
  // token itself never carried a version to compare.
  const noVerForOwner = jwt.sign(
    { sub: U.owner.id, username: U.owner.username },
    config.jwtSecret,
    { expiresIn: '7d', algorithm: 'HS256', issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }
  );
  const legacyOnBumped = await req('GET', '/api/profile', { token: noVerForOwner });
  eq('a claim-less token is still refused for a user past version 0',
    legacyOnBumped.status, 401);

  console.log('\nM11b — logout revokes');
  const before = logoutBumps;
  const editorToken = signToken({ ...U.editor, token_version: U.editor.token_version });
  const out = await req('POST', '/api/auth/logout', { token: editorToken });
  eq('logout is 204', out.status, 204);
  eq('it bumped the version once', logoutBumps, before + 1);
  const afterLogout = await req('GET', '/api/profile', { token: editorToken });
  eq('the token it just retired is refused', afterLogout.status, 401);
  // A second logout presents a token that is already dead, so requireAuth
  // refuses it before the handler runs. That is the correct answer: the session
  // is over either way, and 401 is what a client should clear local state on.
  const outAgain = await req('POST', '/api/auth/logout', { token: editorToken });
  eq('a second logout with the retired token is 401', outAgain.status, 401);
  // The handler itself is idempotent, which is what stops a client that
  // re-authenticates mid-logout from bumping the version twice.
  const fresh = signToken({ id: U.editor.id, username: U.editor.username, token_version: users.find((u) => u.id === U.editor.id).token_version });
  const outThird = await req('POST', '/api/auth/logout', { token: fresh });
  eq('a current token can still log out', outThird.status, 204);

  const deleted = '99999999-9999-4999-8999-999999999999';
  const ghost = signToken({ id: deleted, username: 'ghost', token_version: 0 });
  const ghostRes = await req('GET', '/api/profile', { token: ghost });
  eq('a token for a user that does not exist is refused', ghostRes.status, 401);

  // ---------------------------------------------------------------- M8
  console.log('\nM8 — sign-in timing is flat');
  // Warm the decoy hash first, so the measurement compares steady state rather
  // than a first-call build cost.
  await req('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'x' } });

  async function timeLogins(email, password, n) {
    const times = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      await req('POST', '/api/auth/login', { body: { email, password } });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return times;
  }

  const absent = await timeLogins('absent@example.com', 'wrong-password', 8);
  const wrong = await timeLogins('owner@example.com', 'wrong-password', 8);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const mAbsent = median(absent);
  const mWrong = median(wrong);
  const ratio = Math.max(mAbsent, mWrong) / Math.min(mAbsent, mWrong);
  console.log(`     absent-user median ${mAbsent.toFixed(1)}ms, wrong-password median ${mWrong.toFixed(1)}ms, ratio ${ratio.toFixed(2)}x`);
  check('the two 401 paths cost about the same', ratio < 1.35,
    `ratio ${ratio.toFixed(2)}x — the oracle is still open`);

  const absentRes = await req('POST', '/api/auth/login', { body: { email: 'absent@example.com', password: 'wrong' } });
  const wrongRes = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'wrong' } });
  eq('both are 401', [absentRes.status, wrongRes.status].join(','), '401,401');
  eq('both bodies are identical', absentRes.raw, wrongRes.raw);

  const goodLogin = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-password' } });
  eq('a correct password still signs in', goodLogin.status, 200);
  check('the token it returns is accepted',
    (await req('GET', '/api/profile', { token: goodLogin.body.token })).status === 200);

  // ---------------------------------------------------------------- M9
  console.log('\nM9 — registration is not an enumeration oracle');
  const taken = await req('POST', '/api/auth/register', { body: { username: 'owner', email: 'fresh@example.com', password: 'longenough' } });
  eq('a taken username is 409', taken.status, 409);
  const takenEmail = await req('POST', '/api/auth/register', { body: { username: 'brandnew', email: 'owner@example.com', password: 'longenough' } });
  eq('a taken email is 409', takenEmail.status, 409);
  check('the two 409 bodies are identical', taken.raw === takenEmail.raw,
    'the message distinguishes username from email');
  check('neither names the constraint or the table', !/users_email_key|users_username_key|duplicate key/.test(taken.raw), taken.raw);
  const free = await req('POST', '/api/auth/register', { body: { username: 'brandnew', email: 'fresh@example.com', password: 'longenough' } });
  eq('a genuinely free registration still succeeds', free.status, 201);

  // ---------------------------------------------------------------- M10
  console.log('\nM10 — member-add does not echo the probe');
  const ownerToken = signToken({ ...U.owner, token_version: U.owner.token_version });
  const probe = 'definitely-not-a-real-user-xyz';
  const addRes = await req('POST', `/api/documents/${PROJECT.id}/members`, {
    token: ownerToken,
    body: { identifier: probe, role: 'editor' },
  });
  // Reaching 404 at all is the proof the route got past loadAccess and into the
  // user lookup — a 500 here would mean the branch was never entered and this
  // assertion below would be vacuous.
  eq('an unknown identifier is 404', addRes.status, 404);
  check('the identifier is not echoed back', !addRes.raw.includes(probe), addRes.raw);
  check('the message does not name a column or table', !/users|username =|email =/.test(addRes.raw), addRes.raw);

  // The two shapes a probe can take must be indistinguishable, or the oracle
  // survives in the status code even though the echo is gone.
  const byEmail = await req('POST', `/api/documents/${PROJECT.id}/members`, {
    token: ownerToken,
    body: { identifier: 'also-not-real@example.com', role: 'viewer' },
  });
  eq('an unknown email is 404 too', byEmail.status, 404);
  check('both probes return the same body',
    addRes.raw.replace(probe, 'X') === byEmail.raw.replace('also-not-real@example.com', 'X'),
    `${addRes.raw} vs ${byEmail.raw}`);

  // ---------------------------------------------------------------- M1
  console.log('\nM1 — CORS policy is an allow list');
  const allowed = await req('GET', '/api/ping', { headers: { Origin: 'http://localhost:5173' } });
  eq('the configured origin is reflected', allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  const stranger = await req('GET', '/api/ping', { headers: { Origin: 'https://evil.example' } });
  check('an unlisted origin is not reflected', !stranger.headers['access-control-allow-origin'],
    `got ${stranger.headers['access-control-allow-origin']}`);

  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
