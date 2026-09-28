'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');

// The verification options are the same object for every call, so they are
// built once. Each of the three is a narrowing, and the reason each is here is
// what it stops:
//
//   algorithms  jsonwebtoken takes the algorithm from the token's own header.
//               Left open, a token that says `alg: none`, or names an asymmetric
//               algorithm, is considered. Pinning to the one algorithm this
//               server signs with takes the choice away from whoever wrote the
//               token.
//   issuer      A token minted by something else in the same organisation for a
//               different service would otherwise verify here: same secret, same
//               signature, different intent.
//   audience    The mirror of that — a token minted for a different audience of
//               this same server is refused.
const VERIFY_OPTIONS = {
  algorithms: ['HS256'],
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
};

const SIGN_OPTIONS = {
  expiresIn: config.jwtExpiresIn,
  algorithm: 'HS256',
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
};

/**
 * Sign a JWT for an authenticated user.
 *
 * `ver` is the user's current `token_version`. It is the one claim that can
 * change the meaning of an otherwise-valid token: bumping the version on the
 * user row retires every token carrying the old value, which is what makes
 * logout revoke rather than merely tidy up the client.
 *
 * @param {{id: string, username: string, token_version?: number}} user
 * @returns {string}
 */
function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      ver: Number(user.token_version) || 0,
    },
    config.jwtSecret,
    SIGN_OPTIONS
  );
}

/**
 * Verify and decode a JWT. Throws if invalid, expired, or carrying a claim this
 * server did not put there.
 * @param {string} token
 * @returns {{sub: string, username: string, ver?: number}} The decoded payload.
 */
function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, VERIFY_OPTIONS);
}

/**
 * The `ver` claim of a decoded token, normalised.
 *
 * A token minted before `ver` existed has no such claim and reads as 0, which is
 * what `users.token_version` defaults to. Adding logout must not invalidate every
 * session already in circulation, so the absent claim and the zero claim are the
 * same thing here.
 *
 * @param {object} payload A decoded token payload.
 * @returns {number}
 */
function tokenVersion(payload) {
  return Number(payload && payload.ver) || 0;
}

module.exports = { signToken, verifyToken, tokenVersion, VERIFY_OPTIONS, SIGN_OPTIONS };
