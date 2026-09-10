# Environment Variables

Every variable has a fallback in `src/config/env.js`, so the server boots without a `.env`
file. The fallbacks are development conveniences; two of them are unsafe in production and
are marked below.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Reported on the boot line. |
| `PORT` | `4000` | Listener port. |
| `DATABASE_URL` | `postgresql://mcp_user:mcp_password@localhost:5432/mcp_rag` | PostgreSQL connection string. The database must have pgvector available. |
| `JWT_SECRET` | `default_jwt_secret_for_development` | Signs session tokens. **Must be changed in production**, or anyone can mint a valid session. |
| `JWT_EXPIRES_IN` | `7d` | Session lifetime. |
| `BCRYPT_SALT_ROUNDS` | `10` | Password hashing cost. |
| `ENCRYPTION_KEY` | `default_encryption_key_change_me_in_production` | Run through SHA-256 to derive the AES-256-GCM key that encrypts users' OpenRouter keys. **Must be changed in production.** Rotating it makes every stored key undecryptable. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Base URL for the OpenAI compatible embeddings endpoint. |
| `CORS_ORIGIN` | `*` | Either `*` to reflect any origin, or a comma separated allow list. Trailing slashes are stripped before comparison, so `https://app.com/` and `https://app.com` both match. |
| `AUTO_MIGRATE` | unset | Set to the string `false` to stop `db/init.sql` being applied on boot. Any other value, including unset, applies it. |
| `PG_POOL_MAX` | `10` | Maximum pooled connections. Read directly in `src/config/db.js`. |
| `PG_IDLE_TIMEOUT` | `30000` | Idle client timeout in milliseconds. Read directly in `src/config/db.js`. |

## Notes

**`CORS_ORIGIN=*` is deliberate, not an oversight.** The API authenticates with bearer
tokens rather than cookies, so reflecting the origin does not expose a session to a hostile
page. Narrow it anyway when the deployment has a known frontend origin.

**There is no OpenRouter API key here.** Keys belong to users, are supplied through the web
app, and are stored encrypted. A variable holding a shared key would let one user's
project spend another user's credits, so nothing in this repository reads one.

**`.env.example` also lists frontend variables** such as `VITE_API_URL` and
`FRONTEND_PORT`. The backend does not read them; they are there because the two services
were once brought up from one compose file.
