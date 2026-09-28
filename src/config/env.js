'use strict';

// Centralised environment configuration.
//
// Development keeps a hard-coded fallback for every value, so the app boots with
// no .env file present. Production does not get that convenience. A process that
// starts on a published constant is a process signing sessions anyone can forge
// and decrypting stored API keys anyone can read, so in production it refuses to
// start instead. See assertProductionSecrets below.
require('dotenv').config();

// These are published in this repository and in .env.example. That is harmless
// in development and only ever harmless there, which is why production refuses
// to boot while any one of them is unset or still in use.
const PUBLISHED_DEFAULTS = {
  JWT_SECRET: 'default_jwt_secret_for_development',
  ENCRYPTION_KEY: 'default_encryption_key_change_me_in_production',
  DATABASE_URL: 'postgresql://mcp_user:mcp_password@localhost:5432/mcp_rag',
};

// Proxies in front of this process when TRUST_PROXY is not set. See the note
// beside `trustProxy` in the config object below.
const DEFAULT_TRUST_PROXY_HOPS = 1;

/**
 * Refuse to start a production process that is running on published values.
 *
 * A missing value and a value still set to its published default are the same
 * failure, and the second is the more likely one, because .env.example is
 * copy-pasted. Both are rejected.
 *
 * @param {string} nodeEnv The resolved NODE_ENV.
 * @throws {Error} When production is missing a real value for a required key.
 */
function assertProductionSecrets(nodeEnv) {
  if (nodeEnv !== 'production') return;

  const unset = Object.keys(PUBLISHED_DEFAULTS).filter(
    (key) => !process.env[key]
  );
  const defaulted = Object.keys(PUBLISHED_DEFAULTS).filter(
    (key) => process.env[key] && process.env[key] === PUBLISHED_DEFAULTS[key]
  );

  if (unset.length || defaulted.length) {
    const problems = [];
    if (unset.length) problems.push(`not set: ${unset.join(', ')}`);
    if (defaulted.length) {
      problems.push(`still set to the published default: ${defaulted.join(', ')}`);
    }
    throw new Error(
      'Refusing to start in production. The following must be set to real ' +
        `values in this environment — ${problems.join('; ')}. The defaults in ` +
        'this repository are public, so a process running on them offers ' +
        'forgeable sessions and readable stored keys. Generate each with ' +
        '`openssl rand -hex 32`.'
    );
  }
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 4000,

  // Full connection string is preferred; falls back to a local default in
  // development only, which assertProductionSecrets enforces.
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://mcp_user:mcp_password@localhost:5432/mcp_rag',

  jwtSecret: process.env.JWT_SECRET || 'default_jwt_secret_for_development',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 10,

  // Secret used to derive the AES-256 key that encrypts users' OpenRouter API
  // keys at rest. MUST be overridden in production. Any string works — it is
  // hashed once with SHA-256 to produce the 32-byte key. That is a single fast
  // pass, not a key derivation function; the scrypt change that makes this true
  // is tracked in .agents/memory/tasks/security-hardening.md, task 8.
  encryptionKey:
    process.env.ENCRYPTION_KEY || 'default_encryption_key_change_me_in_production',

  // OpenRouter (OpenAI-compatible) embeddings endpoint base URL.
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',

  corsOrigin: process.env.CORS_ORIGIN || '*',

  // How many proxies sit in front of this process, for the purpose of trusting
  // `X-Forwarded-For`. Anything that limits requests per IP rests on `req.ip`
  // being the client rather than the proxy.
  //
  // The default is 1 because this app is deployed behind exactly one hop (Render
  // terminates TLS and forwards). Left unset, every caller in production shares a
  // single bucket and one noisy client exhausts the budget for everyone.
  //
  // Set `TRUST_PROXY=` (or 0) when running `npm run dev` against the app
  // directly, where there is no proxy and a forged header is the only way to
  // influence the key.
  //
  // `true` is deliberately not supported. It trusts the whole chain, which means
  // trusting whatever the last hop wrote, and the last hop is the client — that
  // hands anyone a working bypass of every per-IP limit by editing a header.
  // Add a proxy in front of Render and this must go to 2.
  trustProxy: (() => {
    const raw = (process.env.TRUST_PROXY || '').trim();
    if (!raw) return DEFAULT_TRUST_PROXY_HOPS;
    const hops = parseInt(raw, 10);
    return Number.isFinite(hops) && hops > 0 ? hops : null;
  })(),
};

assertProductionSecrets(config.nodeEnv);

module.exports = config;
