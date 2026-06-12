'use strict';

const db = require('../config/db');
const { decrypt } = require('./crypto');

/**
 * Fetch and decrypt a user's stored OpenRouter API key.
 * @param {string} userId
 * @returns {Promise<string|null>} plaintext key, or null if the user has none.
 */
async function getDecryptedOpenRouterKey(userId) {
  const { rows } = await db.query(
    `SELECT key_ciphertext, key_iv, key_auth_tag
     FROM user_openrouter_keys
     WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return decrypt({
    ciphertext: rows[0].key_ciphertext,
    iv: rows[0].key_iv,
    authTag: rows[0].key_auth_tag,
  });
}

module.exports = { getDecryptedOpenRouterKey };
