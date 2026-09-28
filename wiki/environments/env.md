# Environment Variables

Every variable has a fallback in `src/config/env.js`, so the server boots without a `.env`
file. The fallbacks are development conveniences; two of them are unsafe in production and
are marked below.

**In production the fallbacks stop being available.** When `NODE_ENV=production`,
`assertProductionSecrets` runs as the config is built and throws before the module is
exported, so the process refuses to start if `JWT_SECRET` or `ENCRYPTION_KEY` is unset or
still holds its published default. `DATABASE_URL` is included in the same check. A
deployment that boots is therefore a deployment that did not run on published constants.

The guard rejects a value *equal to the default* as well as an absent one, and reports
which of the two it found, because copying `.env.example` and leaving the line untouched is
the likelier mistake and produces the same failure.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Reported on the boot line. Setting it to `production` is what arms the secrets guard above. |
| `PORT` | `4000` | Listener port. |
| `DATABASE_URL` | `postgresql://mcp_user:mcp_password@localhost:5432/mcp_rag` | PostgreSQL connection string. The database must have pgvector available. Required in production. |
| `JWT_SECRET` | `default_jwt_secret_for_development` | Signs session tokens. **Required in production**, or anyone can mint a valid session. |
| `JWT_EXPIRES_IN` | `7d` | Session lifetime. |
| `BCRYPT_SALT_ROUNDS` | `10` | Password hashing cost. |
| `ENCRYPTION_KEY` | `default_encryption_key_change_me_in_production` | Run through SHA-256 to derive the AES-256-GCM key that encrypts users' OpenRouter keys. **Required in production.** Rotating it makes every stored key undecryptable. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Base URL for the OpenAI compatible embeddings endpoint. |
| `CORS_ORIGIN` | `*` | Either `*` to reflect any origin, or a comma separated allow list. Trailing slashes are stripped before comparison, so `https://app.com/` and `https://app.com` both match. |
| `TRUST_PROXY` | `1` | How many proxies sit in front of the process, so `req.ip` is the client rather than the proxy. A number only; `true` is rejected on purpose. Set it to `0` or leave it empty to run against the app directly. |
| `AUTO_MIGRATE` | unset | Set to the string `false` to stop `db/init.sql` being applied on boot. Any other value, including unset, applies it. |
| `PG_POOL_MAX` | `10` | Maximum pooled connections. Read directly in `src/config/db.js`. |
| `PG_IDLE_TIMEOUT` | `30000` | Idle client timeout in milliseconds. Read directly in `src/config/db.js`. |

## Notes

**`TRUST_PROXY` is the setting most easily got wrong.** It controls whether Express
believes `X-Forwarded-For`, and every rate limit in this application keys on `req.ip`.

* **`1` (the default)** — trust one hop. Correct for the deployed app, where Render
  terminates TLS and forwards.
* **`0`, or empty** — trust nothing; `req.ip` is the connecting peer. This is what you
  want for `npm run dev` against the app directly, where there is no proxy.
* **`true` is refused.** It trusts the whole chain, which means trusting whatever the
  last hop wrote, and the last hop is the client. That hands anyone a working bypass of
  every per-IP limit by editing a header, so it is not a supported value rather than a
  discouraged one.

Too high and limits can be forged; too low and every caller in production shares one
bucket, so a single noisy client exhausts the budget for everyone. If you put your own
nginx in front of Render, that is a second hop and this must become `2`.

**`CORS_ORIGIN=*` is deliberate, not an oversight.** The API authenticates with bearer
tokens rather than cookies, so reflecting the origin does not expose a session to a hostile
page. Narrow it anyway when the deployment has a known frontend origin.

**There is no OpenRouter API key here.** Keys belong to users, are supplied through the web
app, and are stored encrypted. A variable holding a shared key would let one user's
project spend another user's credits, so nothing in this repository reads one.

**`.env.example` also lists frontend variables** such as `VITE_API_URL` and
`FRONTEND_PORT`. The backend does not read them; they are there because the two services
were once brought up from one compose file.

## Rotating the secrets in a running deployment

The guard stops a future misconfiguration. It cannot reach back to a deployment that
already booted on the published constants, so rotation is a deployment step, and the two
secrets behave differently.

Rotating `JWT_SECRET` invalidates every outstanding session: users are signed out and sign
in again. Rotating `ENCRYPTION_KEY` makes every stored OpenRouter key undecryptable, and
each user has to re-enter theirs. Neither loses data, but both are user-visible, so they
are worth doing deliberately rather than as part of a larger change.
