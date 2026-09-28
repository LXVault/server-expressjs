'use strict';

const db = require('../config/db');
const { verifyToken, tokenVersion } = require('../utils/jwt');

/**
 * Protect a route: requires a valid `Authorization: Bearer <token>` header.
 * On success attaches `req.user = { id, username }`.
 *
 * The signature is not the whole answer. A signed token is only evidence that
 * the server issued it at some point, so two things are checked against live
 * state, and each closes a case a signature alone cannot:
 *
 *   - the user still exists. A token for a deleted account used to keep working
 *     until it expired, because nothing ever asked.
 *   - the `ver` claim still matches the user's `token_version`. This is what
 *     makes logout revoke. Bumping the column retires every outstanding token
 *     at once, which a stateless token cannot do on its own.
 *
 * The cost is one indexed primary-key lookup per authenticated request, which is
 * what buys a session that can actually end.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, username, token_version FROM users WHERE id = $1`,
      [payload.sub]
    ));
  } catch (err) {
    // A database failure is not an authentication result, and reporting it as
    // one would tell a caller their token is bad when it is not. It goes to the
    // error handler, which answers 500.
    return next(err);
  }

  const user = rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (tokenVersion(payload) !== Number(user.token_version)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // The username is read from the row rather than from the token, so a rename
  // takes effect immediately instead of at the next sign-in.
  req.user = { id: user.id, username: user.username };
  return next();
}

module.exports = { requireAuth };
