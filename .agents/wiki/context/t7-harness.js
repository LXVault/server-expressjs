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
  admin: { id: '33333333-3333-4333-8333-333333333333', username: 'admin', email: 'admin@example.com', token_version: 0 },
  viewer: { id: '55555555-5555-4555-8555-555555555555', username: 'viewer', email: 'viewer@example.com', token_version: 0 },
};

let users = [U.owner, U.editor, U.admin, U.viewer];

// A project the owner can administer, so the member-add route is reachable
// rather than stopping at the access check.
const PROJECT = { id: '44444444-4444-4444-8444-444444444444' };
// Each caller's relationship to that project, so the member-management
// authorization can be asked about an owner, an admin, an editor and a viewer
// rather than only the owner. The owner holds no membership row at all — they
// are admitted from documents.owner_id, which is the case worth covering.
const ROLE_BY_USER = {
  [U.owner.id]: null,
  [U.admin.id]: 'admin',
  [U.editor.id]: 'editor',
  [U.viewer.id]: 'viewer',
};
// A realistic bcrypt hash so the timing comparison is against real work. The
// owner's password is fixed because the sign-in assertions below use it.
const PASSWORD_BY_USER = { [U.owner.id]: 'correct-password' };
users = users.map((u) => ({
  ...u,
  password_hash: require('bcryptjs').hashSync(PASSWORD_BY_USER[u.id] || `${u.username}-password`, 10),
}));

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

    // A project, with the caller's relationship resolved per user, so the
    // member-management authorization can be asked about an owner, an admin,
    // an editor and a viewer. Without a reachable row the member-add route
    // never enters the enumeration branch and those tests pass for the wrong
    // reason.
    if (/SELECT d\.\*/.test(text) || /member_role/.test(text)) {
      const callerId = params[1];
      return {
        rows: [{
          id: PROJECT.id,
          owner_id: U.owner.id,
          title: 'Probe project',
          summary: null,
          embedding_model: 'openai/text-embedding-3-small',
          is_owner: callerId === U.owner.id,
          member_role: ROLE_BY_USER[callerId] || null,
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

  // ------------------------------------------------- member administration
  // Membership is owner-or-admin on both the web and the MCP path. The web
  // path used to be owner-only, which contradicted the role model in
  // src/utils/roles.js and disagreed with the MCP path.
  console.log('\nMember management is owner-or-admin, on every surface');
  // Read the live token_version rather than the constant above: the logout
  // block earlier in this harness bumped the editor's, and a token signed with
  // the stale value is refused at requireAuth with a 401 — which would make
  // every assertion below pass or fail for the wrong reason.
  const tokenFor = (u) =>
    signToken({ ...u, token_version: users.find((row) => row.id === u.id).token_version });
  const membersPath = `/api/documents/${PROJECT.id}/members`;

  const asOwner = await req('POST', membersPath, {
    token: tokenFor(U.owner), body: { identifier: 'someone-real', role: 'editor' },
  });
  // 404, not 403: the owner got past the gate and into the user lookup, where
  // the identifier is deliberately absent. Asserting the exact status rather
  // than "not 403" is what stops a 500 from reading as a pass.
  eq('the owner passes the authorization gate and reaches the lookup', asOwner.status, 404);

  const asAdmin = await req('POST', membersPath, {
    token: tokenFor(U.admin), body: { identifier: 'someone-real', role: 'editor' },
  });
  eq('an admin reaches the same point as the owner', asAdmin.status, asOwner.status);

  const asEditor = await req('POST', membersPath, {
    token: tokenFor(U.editor), body: { identifier: 'someone-real', role: 'editor' },
  });
  eq('an editor is refused', asEditor.status, 403);

  const asViewer = await req('POST', membersPath, {
    token: tokenFor(U.viewer), body: { identifier: 'someone-real', role: 'editor' },
  });
  eq('a viewer is refused', asViewer.status, 403);

  check('neither refusal names a role the caller does not hold',
    !/owner only|only the owner/i.test(asEditor.raw + asViewer.raw), asEditor.raw + asViewer.raw);

  // `canManage` is what the web app reads to decide whether to draw the
  // controls at all, so it has to be the same canAdminister answer rather than
  // a second opinion about ownership — otherwise the UI hides the buttons from
  // an admin whose request would have succeeded.
  const listAs = async (u) => {
    const r = await req('GET', membersPath, { token: tokenFor(u) });
    return r.status === 200 ? r.body.canManage : `status ${r.status}`;
  };
  eq('canManage is true for the owner', await listAs(U.owner), true);
  eq('canManage is true for an admin', await listAs(U.admin), true);
  eq('canManage is false for an editor', await listAs(U.editor), false);
  eq('canManage is false for a viewer', await listAs(U.viewer), false);

  // The stub has no branch for the DELETE, so it returns no rows and the route
  // reports 404 — which is the point: reaching the delete at all is what shows
  // the gate opened, and 404 rather than 500 shows it opened cleanly.
  const removeAs = async (u) => (await req('DELETE', `${membersPath}/${U.viewer.id}`, { token: tokenFor(u) })).status;
  eq('an admin reaches the delete', await removeAs(U.admin), 404);
  eq('an editor is refused', await removeAs(U.editor), 403);
  eq('the owner reaches the delete', await removeAs(U.owner), 404);

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
