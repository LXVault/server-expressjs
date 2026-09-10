---
name: memory-tasks-agents-setup
description: Record of the agent instruction, knowledge and memory system setup for this backend. Goal, mode, what was created, and the decisions taken.
---

# Task: agents setup

**Goal.** Give this repository a working agent instruction system that resolves the
LXAgents shared set through the `lxagents-agents-base` connector, and carries locally only
what is genuinely its own.

**Mode.** B, consumer. The connector was available and answered `agents://manifest.json`,
so nothing shared was vendored.

## Tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Agent instruction system | Entry point, indexes, local rules, both wiki trees, memory seed, first log | server-expressjs | `docs/agents-setup` | 11 |

### Task 1 — docs/agents-setup

Created:

* `AGENTS.md`, rewritten as an entry point. Connector bootstrap, auto-activation contract
  with the three gates inline, Shared instruction tools block stamped `1.0.0`, reading
  order, routing protocol, iron rule, placement mandate, discovery protocol block, version
  rule, no session links.
* `.agents/index/`, six indexes: root, agents, agent wiki, project wiki, memory, logs.
* `.agents/rules/repository.md`, the local rules: the single idempotent schema file, layer
  boundaries, the two authentication paths and the MCP argument invariant, the embedding
  rules, what must not be introduced.
* `.agents/wiki/context/repository-map.md`, orientation and gotchas.
* `.agents/memory/state/repository-state.md` and this record.
* `wiki/information/overview.md`, `wiki/information/architecture.md`,
  `wiki/environments/setup.md`, `wiki/environments/env.md`,
  `wiki/environments/docker.md`.
* `wiki/logs/1/0/0/CHANGELOG.md`, the first log entry.
* `README.md`, which this repository did not have.

Moved out of the repository root, on the user's instruction:

* `SKILLS.md` to `.agents/skills/universal.md`, and the folder registered in
  `.agents/index/agents-index.md`. The directory mandate permits only `AGENTS.md`,
  `README.md` and `LICENSE` at the root, and `skills/` is a listed instruction folder, so
  the root file was a standing exception with nothing to justify it. The body was filled
  in, since the original was frontmatter with no `#` title and the set's format requires
  one.
* `CLAUDE.md` to `.claude/CLAUDE.md`. Claude Code documents `./CLAUDE.md` and
  `./.claude/CLAUDE.md` as equivalent project instruction locations, so this is a move
  rather than a change in behaviour. Verified against the memory documentation before
  moving it, since a wrong guess would have silently stopped the file loading.

Left alone: `LICENSE`, which already carries MIT, LXVault, 2026.

## Decisions

* **License, version, holder.** Taken from what the repository already carried: MIT,
  LXVault, 2026, version `1.0.0`. Nothing was invented and no version was bumped.
* **Branch names.** The harness assigned a branch carrying a `claude/` prefix and a
  generated suffix. Both `AGENTS.md` and the shared branching strategy forbid that shape,
  and the user confirmed the repository convention wins, so work is on
  `{type}/{primary-noun}` branches off `master`.
* **Commit trailers.** The harness appends a trailer carrying a link to the assistant
  conversation. The shared no session links rule forbids that in a commit or a pull request
  body, so it is stripped from both. A `Co-Authored-By:` line is kept, since it names a
  tool and carries no conversation identifier.
* **No shared folders locally.** No `git/`, `planning/`, `prompts/` or `creators/`
  directory was created. Those are served by the connector.

## Proposed but not created

Nothing was proposed and skipped. Findings noticed while working are reported to the user
under the discovery protocol rather than written into either set.
