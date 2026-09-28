'use strict';

/**
 * T8 verification harness — the encryption KDF, across a process boundary.
 *
 * The derivation is deterministic given (ENCRYPTION_KEY, salt), so a ciphertext
 * written by one process has to open in the next one. That is the property the
 * deploy depends on and it cannot be checked in-process, where the derived key
 * is already cached from whoever wrote the row. Each case therefore runs a real
 * child with a real environment and reports what it did.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

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

// Produces the ciphertext in this process, so the children are only ever
// decrypting something a real deploy would have written.
process.env.ENCRYPTION_KEY = 't8-original-encryption-key';
process.env.NODE_ENV = 'test';
const { encrypt, decrypt } = require(path.join(ROOT, 'src/utils/crypto'));

const PROBE = 'sk-or-v1-written-by-an-earlier-process';

/** Run one decryption in a clean child with a chosen ENCRYPTION_KEY. */
function decryptInChild(encryptionKey, parts) {
  const script = `
    const path = require('path');
    const ROOT = ${JSON.stringify(ROOT)};
    const { decrypt } = require(path.join(ROOT, 'src/utils/crypto'));
    decrypt(${JSON.stringify(parts)})
      .then((v) => { process.stdout.write('OK:' + v); })
      .catch((e) => { process.stdout.write('ERR:' + e.message); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ENCRYPTION_KEY: encryptionKey, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  return out.startsWith('OK:') ? { ok: true, value: out.slice(3) } : { ok: false, error: out.slice(4) };
}

async function main() {
  const scrypted = await encrypt(PROBE);

  console.log('\nA ciphertext survives a restart');
  const same = decryptInChild('t8-original-encryption-key', scrypted);
  check('a fresh process with the same key opens it', same.ok && same.value === PROBE, JSON.stringify(same));

  console.log('\nRotating the key destroys what it protected');
  const rotated = decryptInChild('t8-rotated-encryption-key', scrypted);
  check('a fresh process with a different key cannot', !rotated.ok, JSON.stringify(rotated));
  check('and the failure names authentication, not a missing row', /authenticate|Unsupported state/i.test(rotated.error || ''), rotated.error);

  console.log('\nA row written before scrypt survives a restart too');
  const nodeCrypto = require('crypto');
  const iv = nodeCrypto.randomBytes(12);
  const legacyKey = nodeCrypto.createHash('sha256').update('t8-original-encryption-key').digest();
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  const enc = Buffer.concat([cipher.update(PROBE, 'utf8'), cipher.final()]);
  const legacy = {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
  const legacySame = decryptInChild('t8-original-encryption-key', legacy);
  check('a fresh process opens it', legacySame.ok && legacySame.value === PROBE, JSON.stringify(legacySame));
  const legacyRotated = decryptInChild('t8-rotated-encryption-key', legacy);
  check('and cannot once the key is rotated', !legacyRotated.ok, JSON.stringify(legacyRotated));

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
