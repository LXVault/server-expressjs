# mcp-rag-server

Express.js backend for the MCP Server with Knowledge Base (RAG) feature. It stores
projects and their knowledge, embeds text into vectors with pgvector, answers semantic
search, and records who did what through which token.

Two clients share the same `/api` surface: the React web app in
[`LXVault/client-reactjs`](https://github.com/LXVault/client-reactjs), authenticated with a
JWT, and the MCP server in [`LXVault/mcp`](https://github.com/LXVault/mcp), authenticated
with a per project token so an assistant's actions stay attributable to a person.

## Features

* Accounts with JWT sessions and bcrypt password hashes.
* Projects with members and the roles `admin`, `editor` and `viewer`.
* Knowledge file ingestion for `.md`, `.txt` and `.pdf`, chunked and embedded.
* Semantic search over pgvector.
* Per project execution tokens, at most one per user per project.
* Per user OpenRouter API keys, encrypted at rest with AES-256-GCM. There is no server
  owned key, so every embedding call spends the acting user's own credits.
* An audit log of every action taken through a token.

## Quick start

```
npm install
npm run dev
curl localhost:4000/health
```

You need a PostgreSQL database with the `pgvector` extension available. Point
`DATABASE_URL` at it; the schema creates itself on first boot. Every variable has a
development fallback, so the server runs without a `.env` file.

## Documentation

* [Overview](wiki/information/overview.md), what the service is and the concepts it uses.
* [Architecture](wiki/information/architecture.md), request flow, the API surface and the
  database schema.
* [Local setup](wiki/environments/setup.md), running and verifying it.
* [Environment variables](wiki/environments/env.md), every value and its fallback.

The full documentation map is
[`.agents/index/project-wiki-index.md`](.agents/index/project-wiki-index.md).

## Working with agents

Agent instructions start at [`AGENTS.md`](AGENTS.md). Shared conventions come from the
LXAgents instruction set served by the `lxagents-agents-base` MCP connector; this
repository carries only what is its own.

## License

MIT. See [`LICENSE`](LICENSE).
