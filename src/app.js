'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config/env');
const { healthCheck } = require('./config/db');

const app = express();

// `X-Powered-By: Express` names the framework and its version to anyone who
// asks, which is a free input to anyone looking for a matching CVE. helmet
// removes it and sets the response headers a browser should see from a JSON API.
app.disable('x-powered-by');
app.use(helmet());

// Only enable this when the app really does sit behind exactly one proxy that
// overwrites `X-Forwarded-For`. It is what makes `req.ip` the client rather than
// the proxy, which any rate limiter keyed on IP depends on. Set it too high and
// a client can forge the header and walk straight through the limit; leave it
// unset when there is no proxy and every request appears to come from the proxy
// itself, which is safe but lumps all callers into one bucket. Unset by default.
if (config.trustProxy !== null) {
  app.set('trust proxy', config.trustProxy);
}

// Build a CORS policy from CORS_ORIGIN.
//   - a name or comma-separated allow-list -> only those origins. Trailing
//     slashes are stripped so "https://app.com/" and "https://app.com" both
//     match.
//   - '*'                                -> reflect any origin. This is not the
//     default, and production refuses to start on it unless
//     ALLOW_ANY_ORIGIN=true says it was meant. See assertProductionCors.
//
// The app authenticates with bearer tokens rather than cookies, so a wildcard
// is not currently exploitable — there is no ambient credential for a hostile
// page to ride. That stops being true the moment either cookie auth or
// `credentials: true` is added, so the wildcard is made to be a decision.
function buildCorsOptions(raw) {
  const trimmed = (raw || '').trim();
  if (trimmed === '*') {
    return { origin: true };
  }
  const allow = trimmed
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return {
    origin(origin, cb) {
      // Non-browser clients (curl, the MCP server) send no Origin — allow them.
      // They are not subject to CORS at all; a browser is, and never sends
      // this request without an Origin.
      if (!origin) return cb(null, true);
      return cb(null, allow.includes(origin.replace(/\/+$/, '')));
    },
  };
}

// --- Essential middleware ---
app.use(cors(buildCorsOptions(config.corsOrigin)));

// The MCP file endpoint carries a whole file as base64 in a JSON field, so it
// needs a body far larger than anything else the API accepts. It gets its own
// parser, mounted BEFORE the global one: body-parser marks the stream as read
// and a second parser skips it, so whichever runs first is the one that counts.
// Every other route therefore gets the small limit, which is what stops one
// request from parking 20 MB of JSON in memory.
app.use('/api/mcp/files', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// --- Health check ---
// Unauthenticated, and therefore the most-read endpoint in the deployment. A
// database error here can carry `password authentication failed for user
// "mcp_user"` or `ECONNREFUSED 10.0.0.5:5432` — which confirms the default
// credentials in this repository are live, names the internal address, and
// tells an attacker which of several causes to chase. The detail goes to the
// log, where it is useful to whoever is on call and unreachable from outside.
app.get('/health', async (req, res) => {
  try {
    const dbOk = await healthCheck();
    res.json({ status: dbOk ? 'ok' : 'degraded' });
  } catch (err) {
    console.error(`[health] database check failed: ${err.message}`);
    res.status(503).json({ status: 'degraded' });
  }
});

app.get('/', (req, res) => {
  res.json({ name: 'mcp-rag-server', version: '1.0.0', status: 'running' });
});

// --- Routes are mounted here (auth & API added in later steps) ---
// eslint-disable-next-line global-require
app.use('/api', require('./routes'));

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Centralised error handler ---
// Two classes of error reach here, and they are treated differently because
// they are different in kind:
//
//   4xx  The request was refused, and this application wrote the message. "No
//         OpenRouter API key configured for your account" is written here, for
//         this caller, and hiding it would help nobody. It is passed through
//         unchanged.
//
//   5xx  Something failed that this application did not anticipate. The
//         message came from node-postgres, an upstream API or a library, and it
//         routinely names tables, columns, constraint names, hostnames and
//         credentials: `duplicate key value violates unique constraint
//         "uq_api_tokens_user_project"`, `password authentication failed for
//         user "mcp_user"`. In production none of that is the caller's business,
//         so the response carries a fixed string and the detail goes to the log.
//
// Development passes the real message through on both, because the point of
// development is to see it. The branch is on nodeEnv rather than on a flag,
// so a deployment cannot turn it off by setting the wrong thing.
//
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err.status) || Number(err.statusCode) || 500;
  const isServerFault = status >= 500;

  // Everything is logged, including 4xx. A rate-limited or refused request is
  // not interesting on its own, but a burst of them is, and the log is the only
  // place the distinction survives.
  if (isServerFault) {
    console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err);
  } else {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  }

  if (res.headersSent) {
    // The response is already partly on the wire; the only correct move is to
    // let Express tear the connection down rather than append a second body.
    return next(err);
  }

  if (isServerFault && config.nodeEnv === 'production') {
    return res.status(status).json({ error: 'Internal Server Error' });
  }

  return res.status(status).json({ error: err.message || 'Internal Server Error' });
});

module.exports = app;
