'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Request rate limits.
 *
 * These bound how often a caller can ask for something over time. They are a
 * different control from the size limits in `src/routes/documents.js` and
 * `fileIngest.js`, which bound how much one request can cost: a caller can send
 * 60 tiny requests a minute forever and never trip a size limit, or send one
 * enormous request and never trip a rate limit. Both are needed.
 *
 * Every limiter keys on `req.ip`, which means every limiter here is only as
 * trustworthy as the `TRUST_PROXY` setting — see `src/config/env.js`. Behind a
 * proxy that does not overwrite `X-Forwarded-For`, the key is the proxy and
 * every caller shares one bucket.
 */

const MINUTE = 60 * 1000;

const shared = {
  // Advertise the budget in the response so a well-behaved client can back off
  // instead of discovering the limit by being cut off.
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * The general API budget. Applies to every route under `/api` that is not
 * covered by a stricter limiter below.
 */
const apiLimiter = rateLimit({
  ...shared,
  windowMs: MINUTE,
  limit: 60,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});

/**
 * Sign-in attempts.
 *
 * Keyed on the address *and* the account being tried, so neither of the two
 * obvious attacks works on its own: one address grinding through many accounts
 * spends a separate budget per account, and one account being ground down from
 * many addresses spends one per address. `skipSuccessfulRequests` means only
 * failures count, so a legitimate user signing in repeatedly is never locked
 * out by their own correct password.
 */
const loginLimiter = rateLimit({
  ...shared,
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    // ipKeyGenerator, not req.ip: an IPv6 address is one caller with many
    // representations, and using it raw lets a single host rotate through them
    // to get an unlimited number of budgets.
    return `${ipKeyGenerator(req.ip)}:${email}`;
  },
  message: {
    error: 'Too many failed sign-in attempts for this account. Try again later.',
  },
});

/**
 * Account creation.
 *
 * Keyed on the address alone, not on the address and the account — the account
 * is the thing being created, so including it would hand every attempt its own
 * budget and the limit would do nothing. This is what stops one host creating
 * thousands of accounts to exhaust the pool of usernames and email addresses.
 *
 * The number is a judgement call and is flagged in the task record. It is a
 * per-address budget, so a group of people behind one office NAT share it.
 */
const registerLimiter = rateLimit({
  ...shared,
  windowMs: 15 * MINUTE,
  limit: 10,
  message: { error: 'Too many accounts created from this address. Try again later.' },
});

/**
 * The MCP surface.
 *
 * Higher than the general budget because the caller is a machine, not a person:
 * an assistant working through a task legitimately makes a burst of calls, and a
 * human-facing budget would break normal use.
 *
 * This is a judgement call and it is flagged in the task record. The plan set a
 * single global limit of 60/min without separating this surface, and 60 is tight
 * for an agent that searches, reads the project, adds knowledge and uploads in
 * one turn. It is not unbounded, which is what matters: a leaked token is still
 * capped, and every MCP write is separately gated on project membership and now
 * expires.
 */
const mcpLimiter = rateLimit({
  ...shared,
  windowMs: MINUTE,
  limit: 120,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});

module.exports = { apiLimiter, loginLimiter, registerLimiter, mcpLimiter };
