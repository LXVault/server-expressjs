'use strict';

const crypto = require('crypto');

// Human-recognisable prefix so leaked tokens are easy to spot in logs/scanners.
const TOKEN_PREFIX = 'mcp_';

/**
 * Generate a fresh, cryptographically-random raw token.
 * The raw value is shown to the user exactly once; only its hash is persisted.
 * @returns {string} e.g. "mcp_3f9a...<64 hex chars>"
 */
function generateRawToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a raw token for storage / lookup. SHA-256 is sufficient here because the
 * input is high-entropy random data (not a low-entropy password).
 * @param {string} rawToken
 * @returns {string} hex-encoded SHA-256 digest
 */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

module.exports = { generateRawToken, hashToken, TOKEN_PREFIX };
