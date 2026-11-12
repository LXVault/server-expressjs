import crypto from 'node:crypto';
import config from '../config/env.js';

// Authenticated symmetric encryption for secrets that must be recovered in
// plaintext later (e.g. a user's OpenRouter API key used for outbound calls).
//
// We deliberately ENCRYPT (reversible) rather than hash: the backend needs the
// original key to call OpenRouter. AES-256-GCM provides confidentiality plus an
// authentication tag that detects tampering on decrypt.

/** What {@link encrypt} produces: base64 parts plus the derivation that made the key. */
export interface EncryptedParts {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  kdf: string;
}

/**
 * What {@link decrypt} accepts. `salt` and `kdf` are absent (null from the
 * database) on a row written before the scrypt change.
 */
export interface StoredParts {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt?: string | null;
  kdf?: string | null;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

// The AES key is derived per row, not per process. Every stored secret gets its
// own random salt, so one stolen ciphertext is attacked on its own rather than
// alongside every other row, and a salt that turns out to be weak is contained
// to the rows that share it.
//
// These parameters are deliberately not configurable. A KDF whose cost can be
// lowered by an environment variable is one mis-set variable away from not being
// a KDF, and that failure is silent — the data is still encrypted, just cheaply.
// 128 * r * N is 128 * 8 * 32768 = 32 MiB per derivation, which is exactly
// node's default `maxmem`, so that limit has to be raised or the call is refused.
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Which derivation produced a row's AES key. Stored per row so ciphertext
// written before scrypt still opens after it, and so the answer survives a
// future change to these parameters.
//
// `sha256` is the single unsalted pass this module used to perform, and it is
// the whole reason this rewrite exists: fast enough that a weak
// ENCRYPTION_KEY can be exhausted at a rate no KDF would allow. A row still
// carrying it is rewritten under scrypt the first time it is read — see
// `getDecryptedOpenRouterKey` in userKeys.js.
export const KDF_SCRYPT = 'scrypt';
export const KDF_LEGACY_SHA256 = 'sha256';

// Derived keys are cached by (derivation, salt). The derivation is
// deterministic, and `config.encryptionKey` is resolved once at require time, so
// an entry cannot go stale inside a process lifetime — rotating the key is a
// restart by definition. Without this, every search, upload and backfill pays
// ~100 ms and ~32 MiB of CPU to recompute a key it already had.
const DERIVED_KEY_CACHE = new Map<string, Buffer>();
const DERIVED_KEY_CACHE_LIMIT = 64;

function cacheGet(cacheKey: string): Buffer | null {
  const hit = DERIVED_KEY_CACHE.get(cacheKey);
  if (hit === undefined) return null;
  // Re-insert so the most recently used key sits at the end of the Map's
  // insertion order, which is the eviction order below.
  DERIVED_KEY_CACHE.delete(cacheKey);
  DERIVED_KEY_CACHE.set(cacheKey, hit);
  return hit;
}

function cacheSet(cacheKey: string, key: Buffer): void {
  DERIVED_KEY_CACHE.set(cacheKey, key);
  while (DERIVED_KEY_CACHE.size > DERIVED_KEY_CACHE_LIMIT) {
    const oldest = DERIVED_KEY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    DERIVED_KEY_CACHE.delete(oldest);
  }
}

function deriveLegacyKey(): Buffer {
  // The pre-scrypt derivation, kept only so ciphertext written before the change
  // can still be read. One fast pass; see KDF_LEGACY_SHA256 above.
  return crypto.createHash('sha256')
    .update(String(config.encryptionKey))
    .digest();
}

function deriveScryptKey(salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // The callback form, not `scryptSync`. This sits on the request path, and
    // the synchronous version holds the event loop for the whole derivation, so
    // one user's key would stall every other request in flight.
    crypto.scrypt(
      String(config.encryptionKey),
      salt,
      KEY_LENGTH,
      SCRYPT_PARAMS,
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/**
 * Resolve the 32-byte AES key for one stored row.
 * @param kdf The derivation named on the row.
 * @param salt The row's salt, or null for the legacy derivation.
 */
async function deriveKey(kdf: string, salt: Buffer | null): Promise<Buffer> {
  const cacheKey = salt ? `${kdf}:${salt.toString('base64')}` : kdf;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let key: Buffer;
  if (kdf === KDF_SCRYPT) {
    if (!salt) {
      throw new Error('This key is marked scrypt but carries no salt');
    }
    key = await deriveScryptKey(salt);
  } else if (kdf === KDF_LEGACY_SHA256) {
    key = deriveLegacyKey();
  } else {
    // Not a fallback to the legacy derivation on purpose. An unrecognised name
    // is a corrupt row or a downgrade attempt, and guessing would report it as
    // an opaque GCM authentication failure instead of saying what is wrong.
    throw new Error(`Unknown key derivation function: ${kdf}`);
  }

  cacheSet(cacheKey, key);
  return key;
}

/**
 * Encrypt a UTF-8 plaintext string under a fresh random salt.
 * @returns base64 parts, plus the derivation and salt needed to open them again.
 */
export async function encrypt(plaintext: string): Promise<EncryptedParts> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  // Derived directly rather than through deriveKey: the salt is new on every
  // call, so the cache could never hit, and routing through it would evict
  // entries that can.
  const key = await deriveScryptKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    salt: salt.toString('base64'),
    kdf: KDF_SCRYPT,
  };
}

/**
 * Decrypt parts produced by {@link encrypt}. Throws if the data was tampered
 * with, the key was rotated, or the derivation is not one this build knows.
 * @returns the original plaintext
 */
export async function decrypt({
  ciphertext,
  iv,
  authTag,
  salt,
  kdf,
}: StoredParts): Promise<string> {
  // A row with no recorded derivation predates scrypt and used one unsalted
  // SHA-256 pass, so absent means legacy rather than broken.
  const name = kdf || KDF_LEGACY_SHA256;
  const key = await deriveKey(name, salt ? Buffer.from(salt, 'base64') : null);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
