// Unit tests for the pure helpers, run against the TypeScript source through tsx.
// Nothing here touches the database: the modules below only import the pool
// type, or never reach a query.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canAdminister, canWrite, isMemberRole, rank, MEMBER_ROLES } from '../src/utils/roles.js';
import {
  isConventionalModelId,
  isValidModelId,
  normalizeModelName,
  toVectorLiteral,
} from '../src/utils/embeddings.js';
import { chunkText, extOf, isAllowedFilename, MAX_CHUNKS_PER_FILE } from '../src/utils/fileIngest.js';
import { generateRawToken, hashToken, TOKEN_PREFIX } from '../src/utils/apiToken.js';
import { signToken, tokenVersion, verifyToken } from '../src/utils/jwt.js';
import { decrypt, encrypt, KDF_SCRYPT } from '../src/utils/crypto.js';
import { httpError } from '../src/types/http.js';

test('roles: ranks, write and administer questions', () => {
  assert.deepEqual([...MEMBER_ROLES], ['viewer', 'editor', 'admin']);
  assert.equal(rank('viewer'), 1);
  assert.equal(rank('admin'), 3);
  assert.equal(rank(null), 0);
  assert.equal(rank('owner'), 0);

  assert.equal(canWrite(true, null), true);
  assert.equal(canWrite(false, 'editor'), true);
  assert.equal(canWrite(false, 'viewer'), false);
  assert.equal(canWrite(false, null), false);

  assert.equal(canAdminister(true, null), true);
  assert.equal(canAdminister(false, 'admin'), true);
  assert.equal(canAdminister(false, 'editor'), false);

  assert.equal(isMemberRole('editor'), true);
  assert.equal(isMemberRole('owner'), false);
});

test('embeddings: model names are normalized and validated', () => {
  assert.equal(normalizeModelName('  OpenAI/Text-Embedding-3-Small '), 'openai/text-embedding-3-small');
  assert.equal(normalizeModelName(''), null);
  assert.equal(normalizeModelName(42), null);
  assert.equal(normalizeModelName('bad model'), null);
  // Express 5 hands a wildcard parameter over as an array; it is not a name.
  assert.equal(normalizeModelName(['openai', 'text-embedding-3-small']), null);

  assert.equal(isConventionalModelId('openai/text-embedding-3-small'), true);
  assert.equal(isConventionalModelId('text-embedding-3-small'), false);
  assert.equal(isConventionalModelId('a/b/c'), false);

  assert.equal(isValidModelId('openai/text-embedding-3-small'), true);
  assert.equal(isValidModelId('x'.repeat(101)), false);

  assert.equal(toVectorLiteral([1, 2.5, -3]), '[1,2.5,-3]');
});

test('fileIngest: extensions and chunking', () => {
  assert.equal(extOf('Notes.MD'), '.md');
  assert.equal(extOf('archive.tar.gz'), '.gz');
  assert.equal(extOf('no-extension'), '');
  assert.equal(isAllowedFilename('a.pdf'), true);
  assert.equal(isAllowedFilename('a.exe'), false);

  assert.deepEqual(chunkText('   '), []);
  assert.deepEqual(chunkText('short text'), ['short text']);

  const long = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1000));
  assert.ok(MAX_CHUNKS_PER_FILE > 0);
});

test('apiToken: prefix, entropy and a stable hash', () => {
  const raw = generateRawToken();
  assert.ok(raw.startsWith(TOKEN_PREFIX));
  assert.equal(raw.length, TOKEN_PREFIX.length + 64);
  assert.notEqual(generateRawToken(), raw);
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.match(hashToken('abc'), /^[0-9a-f]{64}$/);
});

test('jwt: a signed token verifies and carries its version', () => {
  const token = signToken({ id: 'user-1', username: 'alice', token_version: 4 });
  const claims = verifyToken(token);
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.username, 'alice');
  assert.equal(tokenVersion(claims), 4);
  assert.equal(tokenVersion({}), 0);
  assert.throws(() => verifyToken(`${token}x`));
});

test('crypto: encrypt and decrypt round-trip under scrypt', async () => {
  const parts = await encrypt('sk-or-secret-value');
  assert.equal(parts.kdf, KDF_SCRYPT);
  assert.equal(await decrypt(parts), 'sk-or-secret-value');
  await assert.rejects(decrypt({ ...parts, authTag: Buffer.alloc(16).toString('base64') }));
});

test('httpError: an Error carrying status and code', () => {
  const err = httpError('nope', 412, 'X');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'nope');
  assert.equal(err.status, 412);
  assert.equal(err.code, 'X');
  assert.equal('code' in httpError('plain', 400), false);
});
