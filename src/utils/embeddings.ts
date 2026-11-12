import config from '../config/env.js';
import { httpError } from '../types/http.js';

// Suggested embedding models surfaced in the UI. Projects may also enter any
// other OpenRouter model id manually, so this is a convenience list — not a
// hard allowlist.
export const EMBEDDING_MODELS: readonly string[] = [
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
  'openai/text-embedding-ada-002',
];

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

// Deadline on a single call to OpenRouter. `fetch` with no signal waits forever,
// so a hung or slow upstream holds the request — and, during ingestion, a pooled
// database connection is not yet held, but the caller's HTTP slot certainly is.
// Thirty seconds is well beyond a normal embeddings call.
export const EMBEDDING_TIMEOUT_MS = 30_000;

// A model id is a provider-namespaced slug, e.g. "openai/text-embedding-3-small".
// We still validate the shape so junk/oversized strings can't be stored or sent.
/** Arguments to {@link embedText}. */
export interface EmbedRequest {
  /** The user's OpenRouter API key (plaintext). */
  apiKey: string | null | undefined;
  /** A provider-namespaced model id, e.g. one of EMBEDDING_MODELS. */
  model: string | null | undefined;
  /** Text to embed. */
  input: string;
}

/** The part of OpenRouter's OpenAI-compatible response this module reads. */
interface EmbeddingsResponse {
  data?: Array<{ embedding?: unknown }>;
}

const MODEL_ID_RE = /^[A-Za-z0-9._/:-]{1,100}$/;

export function isValidModelId(model: unknown): model is string {
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
 * @returns The canonical name, or null if the shape is unusable.
 */
export function normalizeModelName(model: unknown): string | null {
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
 */
export function isConventionalModelId(model: unknown): boolean {
  const canonical = normalizeModelName(model);
  if (!canonical) return false;
  const segments = canonical.split('/');
  return segments.length === 2 && Boolean(segments[0]) && Boolean(segments[1]);
}

/**
 * Produce an embedding for a single piece of text via OpenRouter's
 * OpenAI-compatible embeddings endpoint, using the caller's own API key.
 *
 * @returns The embedding vector.
 */
export async function embedText({ apiKey, model, input }: EmbedRequest): Promise<number[]> {
  if (!apiKey) {
    throw httpError('No OpenRouter API key available for this user', 412);
  }
  if (!isValidModelId(model)) {
    throw httpError(`Invalid embedding model id: ${model}`, 400);
  }

  let res: Response;
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
    const cause = networkErr as Error;
    const timedOut = cause.name === 'TimeoutError';
    throw httpError(
      timedOut
        ? `OpenRouter did not respond within ${EMBEDDING_TIMEOUT_MS}ms`
        : `Could not reach OpenRouter: ${cause.message}`,
      502
    );
  }

  const text = await res.text();
  let data: EmbeddingsResponse | null = null;
  try {
    data = text ? (JSON.parse(text) as EmbeddingsResponse) : null;
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
    // The code distinguishes "fix your key" from "the provider is unhappy"
    // without exposing the upstream's own explanation. The upload path reports
    // it rather than the status, which is why it is here and not in the message.
    throw httpError(
      authProblem
        ? 'OpenRouter rejected your API key. Check the key saved in your profile.'
        : 'OpenRouter could not generate embeddings for this model.',
      502,
      authProblem ? 'UPSTREAM_KEY_REJECTED' : 'UPSTREAM_ERROR'
    );
  }

  const vector = data && data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(vector)) {
    throw httpError('OpenRouter returned an unexpected embeddings response', 502);
  }
  return vector as number[];
}

// pgvector accepts a vector literal like '[1,2,3]'. Cast with $n::vector.
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
