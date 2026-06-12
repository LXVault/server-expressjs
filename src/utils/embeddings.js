'use strict';

const config = require('../config/env');

// Embedding models selectable per project. Kept as an allowlist so an arbitrary
// (and possibly non-embedding) model id can't be injected via the API.
const EMBEDDING_MODELS = [
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
  'openai/text-embedding-ada-002',
];

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

function isAllowedModel(model) {
  return EMBEDDING_MODELS.includes(model);
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
  if (!isAllowedModel(model)) {
    const err = new Error(`Unsupported embedding model: ${model}`);
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
    });
  } catch (networkErr) {
    const err = new Error(`Could not reach OpenRouter: ${networkErr.message}`);
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
    const message =
      (data && data.error && (data.error.message || data.error)) ||
      `OpenRouter embeddings request failed (${res.status})`;
    const err = new Error(String(message));
    // Surface auth problems clearly so the user knows to fix their key.
    err.status = res.status === 401 || res.status === 403 ? 401 : 502;
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
  isAllowedModel,
  embedText,
  toVectorLiteral,
};
