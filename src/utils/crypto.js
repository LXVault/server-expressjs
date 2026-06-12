'use strict';

const crypto = require('crypto');
const config = require('../config/env');

// Authenticated symmetric encryption for secrets that must be recovered in
// plaintext later (e.g. a user's OpenRouter API key used for outbound calls).
//
// We deliberately ENCRYPT (reversible) rather than hash: the backend needs the
// original key to call OpenRouter. AES-256-GCM provides confidentiality plus an
// authentication tag that detects tampering on decrypt.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM

// Derive a stable 32-byte key from the configured secret. Using a KDF means the
// operator can supply any-length ENCRYPTION_KEY and we still get a valid key.
const KEY = crypto.createHash('sha256').update(String(config.encryptionKey)).digest();

/**
 * Encrypt a UTF-8 plaintext string.
 * @param {string} plaintext
 * @returns {{ ciphertext: string, iv: string, authTag: string }} base64 parts
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt parts produced by {@link encrypt}. Throws if the data was tampered
 * with or the key changed.
 * @param {{ ciphertext: string, iv: string, authTag: string }} parts
 * @returns {string} the original plaintext
 */
function decrypt({ ciphertext, iv, authTag }) {
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt };
