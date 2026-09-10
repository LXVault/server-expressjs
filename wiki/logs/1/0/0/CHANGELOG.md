# 1.0.0

Released 2026-09-10.

The backend as it stands, plus the agent instruction, knowledge and memory system.

## Added

* Accounts: register, login, JWT sessions, bcrypt password hashes.
* Projects, stored as `documents`, with members and the roles `admin`, `editor` and
  `viewer`.
* Per project execution tokens, at most one per user per project, so an action taken by
  the MCP server traces back to the user who issued the token.
* Knowledge file ingestion for `.md`, `.txt` and `.pdf`, shared by the web upload path and
  the MCP upload path so the two behave identically.
* Semantic search over pgvector by exact KNN, using the project's embedding model.
* Per user OpenRouter API keys, encrypted at rest with AES-256-GCM. No server owned key.
* An audit log recording actor, token, action and target.
* `GET /api/analysis`, aggregates for the web app's charts.
* Idempotent schema application on boot from `db/init.sql`, so managed databases stay in
  sync without a migration step.
* The agent instruction system: `AGENTS.md` as an entry point resolving the LXAgents shared
  set through the `lxagents-agents-base` connector, `.agents/` with indexes, local rules,
  agent knowledge and memory, and this `wiki/` tree.
* `README.md`, which the repository previously did not have.

## Changed

* `SKILLS.md` moved from the repository root to `.agents/skills/universal.md`, and the
  folder was registered in the agents index. Only `AGENTS.md`, `README.md` and `LICENSE`
  belong at the root, and `skills/` is an instruction folder like any other. Its body was
  filled in, since the original carried frontmatter with no title.
* `CLAUDE.md` moved to `.claude/CLAUDE.md`, which Claude Code treats as an equivalent
  project instruction location, so nothing about how it loads changes.
