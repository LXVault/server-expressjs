'use strict';

const config = require('../config/env');

// Suggested embedding models surfaced in the UI. Projects may also enter any
// other OpenRouter model id manually, so this is a convenience list — not a
// hard allowlist.
const EMBEDDING_MODELS = [
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
  'openai/text-embedding-ada-002',
];

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

// Deadline on a single call to OpenRouter. `fetch` with no signal waits forever,
// so a hung or slow upstream holds the request — and, during ingestion, a pooled
// database connection is not yet held, but the caller's HTTP slot certainly is.
// Thirty seconds is well beyond a normal embeddings call.
const EMBEDDING_TIMEOUT_MS = 30_000;

// A model id is a provider-namespaced slug, e.g. "openai/text-embedding-3-small".
// We still validate the shape so junk/oversized strings can't be stored or sent.
const MODEL_ID_RE = /^[A-Za-z0-9._/:-]{1,100}$/;

function isValidModelId(model) {
  return typeof model === 'string' && MODEL_ID_RE.test(model.trim());
}

/**
 * Canonical spelling of a stored model identifier: trimmed and lower-cased.
 *
 * Every write to a `model_name` column goes through this, so one model can
 * never exist under two spellings. Normalising on the way in is what makes the
 * (chunk_id, model_name) primary key mean "one vector per model" rather than
 * "one vector per way of typing the model".
 *
 * @param {*} model
 * @returns {string|null} The canonical name, or null if the shape is unusable.
 */
function normalizeModelName(model) {
  if (typeof model !== 'string') return null;
  const canonical = model.trim().toLowerCase();
  if (!canonical || !MODEL_ID_RE.test(canonical)) return null;
  return canonical;
}

/**
 * Whether a model id follows the {platform}/{model} convention: exactly one
 * slash, with a non-empty segment either side.
 *
 * Enforced when a person CHOOSES a model, so nothing new enters the system
 * without a platform segment. Reads stay tolerant, because a database written
 * before this was enforced may hold a bare name and its chunks must keep
 * working.
 *
 * @param {*} model
 * @returns {boolean}
 */
function isConventionalModelId(model) {
  const canonical = normalizeModelName(model);
  if (!canonical) return false;
  const segments = canonical.split('/');
  return segments.length === 2 && Boolean(segments[0]) && Boolean(segments[1]);
}

/**
 * Produce an embedding for a single piece of text via OpenRouter's
 * OpenAI-compatible embeddings endpoint, using the caller's own API key.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey  The user's OpenRouter API key (plaintext).
 * @param {string} opts.model   One of EMBEDDING_MODELS.
 * @param {string} opts.input   Text to embed.
 * @returns {Promise<number[]>} The embedding vector.
 */
async function embedText({ apiKey, model, input }) {
  if (!apiKey) {
    const err = new Error('No OpenRouter API key available for this user');
    err.status = 412;
    throw err;
  }
  if (!isValidModelId(model)) {
    const err = new Error(`Invalid embedding model id: ${model}`);
    err.status = 400;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${config.openrouterBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
  } catch (networkErr) {
    // A timeout is not "could not reach OpenRouter" and reads as one to whoever
    // sees the error, so it is named for what it was.
    const timedOut = networkErr.name === 'TimeoutError';
    const err = new Error(
      timedOut
        ? `OpenRouter did not respond within ${EMBEDDING_TIMEOUT_MS}ms`
        : `Could not reach OpenRouter: ${networkErr.message}`
    );
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // fall through to error handling below
  }

  if (!res.ok) {
    // OpenRouter's error body is not forwarded. It is the upstream's wording
    // and can carry account identifiers, model availability notes and
    // internal references; a caller of this API has no business reading it, and
    // a reflected upstream body is a way to probe somebody else's service
    // through this endpoint. It is logged, whole, for whoever is debugging.
    console.error(
      `[embeddings] OpenRouter returned ${res.status} for model ${model}: ${text}`
    );
    // A rejected key is a 502 here rather than a 401. The caller of this API is
    // authenticated; it is OpenRouter that refused, and answering 401 would
    // tell a signed-in user their session is bad. The distinction is preserved
    // in the log, not in the status a client sees.
    const authProblem = res.status === 401 || res.status === 403;
    const err = new Error(
      authProblem
        ? 'OpenRouter rejected your API key. Check the key saved in your profile.'
        : 'OpenRouter could not generate embeddings for this model.'
    );
    err.status = 502;
    // Distinguishes "fix your key" from "the provider is unhappy" without
    // exposing the upstream's own explanation. The upload path reports this
    // rather than the status, which is why it is here and not in the message.
    err.code = authProblem ? 'UPSTREAM_KEY_REJECTED' : 'UPSTREAM_ERROR';
    throw err;
  }

  const vector = data && data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(vector)) {
    const err = new Error('OpenRouter returned an unexpected embeddings response');
    err.status = 502;
    throw err;
  }
  return vector;
}

// pgvector accepts a vector literal like '[1,2,3]'. Cast with $n::vector.
function toVectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

module.exports = {
  EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_TIMEOUT_MS,
  isValidModelId,
  isConventionalModelId,
  normalizeModelName,
  embedText,
  toVectorLiteral,
};
