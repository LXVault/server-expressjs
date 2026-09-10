---
name: root-index
description: Router for this repository's local instruction set. Lists every local index and the shared router, and records the shared overrides in force.
---

# Root Index

This file lists indexes only. It never carries rules, never carries documentation, and
never links to a leaf file. Read exactly one branch per task, plus `memory-index.md`.

## Child Indexes

| Index | Scope | Load when |
|---|---|---|
| [`agents-index.md`](agents-index.md) | This repository's instruction set | You need a rule specific to this backend. |
| `{shared}/index/root-index.md` | The shared instruction set | You need a branching, commit, pull request, planning, or creator convention. |
| [`agent-wiki-index.md`](agent-wiki-index.md) | `.agents/wiki/` agent knowledge | You need an SOP, domain guideline, or operating context written for agents. |
| [`project-wiki-index.md`](project-wiki-index.md) | `wiki/` human documentation | You need to read or write documentation a person will read. |
| [`memory-index.md`](memory-index.md) | `.agents/memory/` dynamic state | You need prior task state or must record progress. |
| [`logs-index.md`](logs-index.md) | `wiki/logs/` versioned change logs | You need release history or must record a change. |

## Shared Overrides

No overrides. This repository uses the shared set unchanged.

| `name` | Local file | Replaces | Why |
|---|---|---|---|

## Maintenance

Adding, removing, or renaming any index updates this table in the same commit. Adding or
dropping an override updates the override table in the same commit.
