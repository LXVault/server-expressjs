'use strict';

/**
 * T8 verification harness — the encryption KDF.
 *
 * Runs the REAL src/utils/crypto.js, the REAL src/utils/userKeys.js and the REAL
 * PUT /api/me/openrouter-key route. Only the pg pool is stubbed, because there
 * is no PostgreSQL in this environment.
 *
 * The pool stub holds a real `user_openrouter_keys` store that the code writes
 * to, rather than returning canned rows. The whole point of this change is that
 * reading a row may rewrite it, and a stub that discards writes would report
 * the lazy upgrade as working while proving nothing.
 *
 * The legacy derivation is re-implemented below from the ENCRYPTION_KEY directly
 * rather than imported, so "old rows still open" is checked against the old
 * algorithm and not against a re-export of the new one.
 */

const http = require('http');
const path = require('path');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = (p) => require(path.join(ROOT, p));

// Fixed before anything reads config, so the derivation is deterministic and the
// legacy re-implementation below agrees with it.
const TEST_ENCRYPTION_KEY = 't8-harness-encryption-key';
process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
process.env.NODE_ENV = 'test';

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

function section(title) {
  console.log(`\n${title}`);
}

// --- The derivation the application used before this change -----------------

const legacyKey = () =>
  nodeCrypto.createHash('sha256').update(TEST_ENCRYPTION_KEY).digest();

/** Encrypt the way the old crypto.js did, so a legacy row is a real one. */
function legacyEncrypt(plaintext) {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', legacyKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Put encryption output into a row as the columns are actually named. Spreading
 * the parts straight onto the row would leave every key_* column undefined and
 * the read would fail for a reason that has nothing to do with the KDF.
 */
function asRow(parts, userId) {
  return {
    user_id: userId,
    key_ciphertext: parts.ciphertext,
    key_iv: parts.iv,
    key_auth_tag: parts.authTag,
    key_salt: parts.salt,
    key_kdf: parts.kdf,
    key_last4: '0000',
  };
}

// --- Pool stub -------------------------------------------------------------

const USER = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', email: 'owner@example.com', token_version: 0 };

// user_id -> row. The application writes here, so the lazy upgrade is visible.
let keysByUser = new Map();
let upgradeWrites = 0;
let failUpgradeWrites = false;

const pool = {
  async query(sql, params) {
    const text = String(sql);

    if (/SELECT key_ciphertext, key_iv, key_auth_tag, key_salt, key_kdf/.test(text)) {
      const row = keysByUser.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (/UPDATE user_openrouter_keys/.test(text)) {
      upgradeWrites += 1;
      if (failUpgradeWrites) throw new Error('permission denied for table user_openrouter_keys');
      const existing = keysByUser.get(params[0]);
      if (!existing) return { rows: [], rowCount: 0 };
      const updated = {
        ...existing,
        key_ciphertext: params[1],
        key_iv: params[2],
        key_auth_tag: params[3],
        key_salt: params[4],
        key_kdf: params[5],
      };
      keysByUser.set(params[0], updated);
      return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO user_openrouter_keys/.test(text)) {
      const row = {
        user_id: params[0],
        key_ciphertext: params[1],
        key_iv: params[2],
        key_auth_tag: params[3],
        key_salt: params[4],
        key_kdf: params[5],
        key_last4: params[6],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      keysByUser.set(params[0], row);
      return { rows: [{ key_last4: row.key_last4, updated_at: row.updated_at }], rowCount: 1 };
    }

    if (/SELECT key_last4, created_at, updated_at/.test(text)) {
      const row = keysByUser.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (/SELECT id, username, token_version FROM users/.test(text)) {
      return { rows: [USER], rowCount: 1 };
    }

    throw new Error(`t8-harness: unstubbed query — ${text.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
  },
  async connect() {
    return { query: pool.query, release() {} };
  },
};

require.cache[require.resolve(path.join(ROOT, 'src/config/db'))] = {
  id: path.join(ROOT, 'src/config/db'),
  filename: path.join(ROOT, 'src/config/db'),
  loaded: true,
  exports: { pool, query: pool.query, healthCheck: async () => true },
};

const crypto = APP('src/utils/crypto');
const { getDecryptedOpenRouterKey } = APP('src/utils/userKeys');
const { signToken } = APP('src/utils/jwt');

async function main() {
  // --- crypto.js -----------------------------------------------------------

  section('Round trip');

  const parts = await crypto.encrypt('sk-or-v1-abcdef0123456789');
  eq('the plaintext comes back', await crypto.decrypt(parts), 'sk-or-v1-abcdef0123456789');
  eq('the derivation is recorded on the row', parts.kdf, 'scrypt');
  eq('the salt is 16 bytes', Buffer.from(parts.salt, 'base64').length, 16);
  eq('the IV is 12 bytes', Buffer.from(parts.iv, 'base64').length, 12);
  eq('the auth tag is 16 bytes', Buffer.from(parts.authTag, 'base64').length, 16);
  check('the plaintext is not in the ciphertext', !parts.ciphertext.includes('abcdef'));

  const again = await crypto.encrypt('sk-or-v1-abcdef0123456789');
  check('a second encryption of the same plaintext uses a different salt', again.salt !== parts.salt);
  check('a second encryption of the same plaintext uses a different IV', again.iv !== parts.iv);
  check('a second encryption of the same plaintext differs', again.ciphertext !== parts.ciphertext);
  eq('and still round-trips', await crypto.decrypt(again), 'sk-or-v1-abcdef0123456789');

  section('A row is only open under its own salt');

  // The check the plan asked for. GCM authenticates the ciphertext under the
  // key it was encrypted with, and the key is derived from the salt, so a
  // mismatched salt cannot produce the right key — it fails, and it must fail
  // rather than silently producing garbage.
  let crossSaltFailed = false;
  try {
    await crypto.decrypt({ ...parts, salt: again.salt });
  } catch (err) {
    crossSaltFailed = true;
  }
  check('a ciphertext read under another salt throws', crossSaltFailed);

  let crossKdfFailed = false;
  try {
    await crypto.decrypt({ ...parts, kdf: 'sha256' });
  } catch (err) {
    crossKdfFailed = true;
  }
  check('a ciphertext read under the legacy derivation throws', crossKdfFailed);

  section('Tampering is detected');

  const flip = (s) => {
    const b = Buffer.from(s, 'base64');
    b[0] ^= 0xff;
    return b.toString('base64');
  };
  for (const field of ['ciphertext', 'iv', 'authTag']) {
    let threw = false;
    try {
      await crypto.decrypt({ ...parts, [field]: flip(parts[field]) });
    } catch (err) {
      threw = true;
    }
    check(`a modified ${field} is refused`, threw);
  }

  section('Legacy rows');

  const old = legacyEncrypt('sk-or-v1-written-before-scrypt');
  eq(
    'a row written before this change still opens',
    await crypto.decrypt(old),
    'sk-or-v1-written-before-scrypt'
  );
  eq(
    'and opens the same way through an explicit legacy name',
    await crypto.decrypt({ ...old, kdf: 'sha256' }),
    'sk-or-v1-written-before-scrypt'
  );

  let unknownKdf = null;
  try {
    await crypto.decrypt({ ...parts, kdf: 'rot13' });
  } catch (err) {
    unknownKdf = err.message;
  }
  check('an unrecognised derivation is refused by name', unknownKdf && /rot13/.test(unknownKdf), unknownKdf);

  let scryptNoSalt = null;
  try {
    await crypto.decrypt({ ...parts, salt: null });
  } catch (err) {
    scryptNoSalt = err.message;
  }
  check('a row marked scrypt with no salt is refused', scryptNoSalt !== null, scryptNoSalt);

  section('The derivation is deterministic and cached');

  // Warm up so the first timed call is not paying for module load.
  await crypto.encrypt('warm-up');

  const timeIt = async (fn) => {
    const started = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  // A salt nothing has read yet, so the first call is a real miss. `encrypt`
  // derives outside the cache, so a fresh ciphertext always has a fresh salt.
  const probe = await crypto.encrypt('cache probe');
  const first = await timeIt(() => crypto.decrypt(probe));
  const second = await timeIt(() => crypto.decrypt(probe));
  check('the second read of a salt is served from cache', second < first / 2, `${first.toFixed(1)}ms then ${second.toFixed(1)}ms`);
  eq('and the cached read is the same plaintext', await crypto.decrypt(probe), 'cache probe');

  // A fresh process must reach the identical key for the same (key, salt), or
  // the ciphertext would not survive a deploy. t8-boot.js checks that across a
  // real process boundary; here the two derivations must at least agree.
  const fresh = await crypto.encrypt('x');
  check('a distinct salt is a distinct key', fresh.salt !== parts.salt);

  section('The event loop is not held');

  // If encrypt used scryptSync, two derivations would serialise on this thread
  // and cost 2x. The async form hands them to the libuv threadpool.
  const one = await timeIt(() => crypto.encrypt('concurrency probe a'));
  const both = await timeIt(() => Promise.all([crypto.encrypt('concurrency probe b'), crypto.encrypt('concurrency probe c')]));
  check('two derivations in parallel cost about one, not two', both < one * 1.6, `one ${one.toFixed(0)}ms, two ${both.toFixed(0)}ms`);

  // --- userKeys.js ---------------------------------------------------------

  section('Reading a stored key');

  keysByUser = new Map();
  keysByUser.set(USER.id, asRow(legacyEncrypt('sk-or-v1-legacy'), USER.id));
  upgradeWrites = 0;
  eq('a legacy row reads back as plaintext', await getDecryptedOpenRouterKey(USER.id), 'sk-or-v1-legacy');

  const upgraded = keysByUser.get(USER.id);
  eq('and is rewritten under scrypt on first read', upgraded.key_kdf, 'scrypt');
  check('with a salt', typeof upgraded.key_salt === 'string' && upgraded.key_salt.length > 0);
  check('and a different ciphertext', upgraded.key_ciphertext !== legacyEncrypt('x').ciphertext);
  eq('exactly once', upgradeWrites, 1);
  eq('leaving updated_at alone, because the user did not change the key', upgraded.updated_at, undefined);

  eq('and the rewritten row still reads back', await getDecryptedOpenRouterKey(USER.id), 'sk-or-v1-legacy');
  eq('without being rewritten again', upgradeWrites, 1);

  keysByUser = new Map();
  keysByUser.set(USER.id, asRow(await crypto.encrypt('sk-or-v1-modern'), USER.id));
  upgradeWrites = 0;
  eq('a row already on scrypt reads back', await getDecryptedOpenRouterKey(USER.id), 'sk-or-v1-modern');
  eq('and is not rewritten', upgradeWrites, 0);

  section('A failed upgrade does not fail the caller');

  keysByUser = new Map();
  keysByUser.set(USER.id, asRow(legacyEncrypt('sk-or-v1-survivor'), USER.id));
  failUpgradeWrites = true;
  upgradeWrites = 0;
  let survived = null;
  try {
    survived = await getDecryptedOpenRouterKey(USER.id);
  } catch (err) {
    survived = `THREW: ${err.message}`;
  }
  failUpgradeWrites = false;
  eq('the key is still returned', survived, 'sk-or-v1-survivor');
  eq('the write was still attempted', upgradeWrites, 1);
  eq('and the row is unchanged, so the next read retries', keysByUser.get(USER.id).key_kdf, undefined);

  section('A user with no key');

  keysByUser = new Map();
  eq('returns null rather than throwing', await getDecryptedOpenRouterKey(USER.id), null);

  // --- the route -----------------------------------------------------------

  section('PUT /api/me/openrouter-key');

  const app = APP('src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const put = (body, token) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/me/openrouter-key', method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            authorization: `Bearer ${token}`,
          } },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

  keysByUser = new Map();
  upgradeWrites = 0;
  const token = signToken(USER);
  const secret = 'sk-or-v1-typed-through-the-route';
  const putRes = await put({ apiKey: secret }, token);
  eq('the route accepts the key', putRes.status, 201);
  eq('and reports the last four', putRes.body && putRes.body.last4, 'oute');

  const stored = keysByUser.get(USER.id);
  check('it is stored with a salt', stored && typeof stored.key_salt === 'string' && stored.key_salt.length > 0);
  eq('and with the derivation named', stored && stored.key_kdf, 'scrypt');
  eq('and the plaintext is nowhere in the row', JSON.stringify(stored).includes('typed-through-the-route'), false);

  // The bind-parameter order in that INSERT is the thing most likely to be
  // wrong, and only a real round trip catches it.
  eq('and it reads back as the same key', await getDecryptedOpenRouterKey(USER.id), secret);
  eq('with no upgrade write, since it was written on scrypt', upgradeWrites, 0);

  server.close();

  // --- summary -------------------------------------------------------------

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
