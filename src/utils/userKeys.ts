import * as db from '../config/db.js';
import { encrypt, decrypt } from './crypto.js';

/** A `user_openrouter_keys` row as read by {@link getDecryptedOpenRouterKey}. */
interface StoredKeyRow {
  key_ciphertext: string;
  key_iv: string;
  key_auth_tag: string;
  key_salt: string | null;
  key_kdf: string | null;
}

// A row written before the scrypt change carries no salt and no derivation name.
// Both columns are added to db/init.sql as nullable, so "absent" is exactly what
// a legacy row looks like and nothing has to be backfilled.
function isLegacyRow(row: StoredKeyRow): boolean {
  return !row.key_kdf;
}

/**
 * Rewrite one user's stored key under scrypt.
 *
 * Runs at most once per row, the first time it is read after the change. It is
 * best effort by design: this is a maintenance write on a read path, and the
 * plaintext has already been recovered, so failing the caller's request over it
 * would be worse than leaving the row to be retried on the next read.
 *
 * `updated_at` is deliberately not touched. The user did not change their key;
 * the column records when they set it, and bumping it here would tell the web
 * app the key had just been re-entered.
 *
 * @param userId
 * @param apiKey the plaintext just decrypted from the legacy row
 */
async function upgradeToScrypt(userId: string, apiKey: string): Promise<void> {
  try {
    const { ciphertext, iv, authTag, salt, kdf } = await encrypt(apiKey);
    await db.query(
      `UPDATE user_openrouter_keys
          SET key_ciphertext = $2,
              key_iv         = $3,
              key_auth_tag   = $4,
              key_salt       = $5,
              key_kdf        = $6
        WHERE user_id = $1`,
      [userId, ciphertext, iv, authTag, salt, kdf]
    );
  } catch (err) {
    // A user id in a server-side log is unremarkable — audit_logs carries the
    // same value on every write — and without it this is a silent failure that
    // leaves a row on the fast derivation indefinitely.
    console.error(
      `[userKeys] stored OpenRouter key for user ${userId} stays on the ` +
        `pre-scrypt derivation: ${(err as Error).message}`
    );
  }
}

/**
 * Fetch and decrypt a user's stored OpenRouter API key.
 * @returns plaintext key, or null if the user has none.
 */
export async function getDecryptedOpenRouterKey(userId: string): Promise<string | null> {
  const { rows } = await db.query<StoredKeyRow>(
    `SELECT key_ciphertext, key_iv, key_auth_tag, key_salt, key_kdf
     FROM user_openrouter_keys
     WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;

  const apiKey = await decrypt({
    ciphertext: row.key_ciphertext,
    iv: row.key_iv,
    authTag: row.key_auth_tag,
    salt: row.key_salt,
    kdf: row.key_kdf,
  });

  if (isLegacyRow(row)) await upgradeToScrypt(userId, apiKey);

  return apiKey;
}
