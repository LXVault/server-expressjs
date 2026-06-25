# Agent Instructions

**Strict Rules:**
* Agents must read `AGENTS.md`, `SKILLS.md`, and all `README.md` files located within the documented Agent Directories, and save their entire contents within memory.
* Agents must ask for the user's approval before editing `AGENTS.md` or `SKILLS.md`.
* Every agent-related directory (e.g., `.agents/`, `.skills/`, `.tools/`) must contain a `README.md` file that serves as the index for its contents. Do not index these files in the root `AGENTS.md` or `SKILLS.md`.
* Never work directly on the `master` or `main` branch.
* Always verify if your current task aligns with the active branch. If it does not, create a new branch. Do not create a new branch if you are continuing existing work on the appropriate branch.
* When finishing work, you must also check the code security for any files that were modified and committed in the current branch.
* Code and comments must not contain dashes.

The root `AGENTS.md` and `SKILLS.md` files must remain universally applicable to the entire repository. If you conceptualize a new instruction, skill, tool, or any context-specific data that is not universally applicable, create it within the appropriate Agent Directory (such as `.agents/`, `.skills/`, `.tools/`, `.personas/`, etc.) instead.

## Agent Directories

| Name | Description |
|---|---|
| `.tools/` | Contains definitions, schemas, or scripts of tools the agents are permitted to use. |
| `.knowledge/` | Domain-specific context, reference documents, or knowledge base for the agent. |
| `.personas/` | Defines specific roles, personalities, or perspectives for agents to adopt. |
| `.ethics/` | Safety bounds, ethical guidelines, and constraints to ensure responsible agent behavior. |

## Suggesting New Content

While working, if you discover a useful idea, rule, or skill that could improve `AGENTS.md` or `SKILLS.md`, do not apply the changes immediately. Instead, upon finishing your current task, suggest the new additions to the user and allow them to decide whether to integrate them.

# Git & Branching Workflow

* **Branch Isolation (CRITICAL):** If the current branch is master, checkout a new branch immediately before making modifications.
* **Task Scoping:** When you start work from a user prompt, check whether it relates to the current branch. If the task is unrelated, create a new branch specific to it. If the work stays within the current scope (for example, adding a new function or fixing an error in existing work) do not create a new branch; continue on the current one.
* **Branch Naming (STRICT):** Must strictly follow the `{type}/{primary_noun}` or `{type}/{primary_noun}_{secondary_noun}` format. Do not use verbs or Jira IDs.
  * Allowed Types: `feat/`, `fix/`, `docs/`, `style/`, `refactor/`, `perf/`, `test/`, `build/`, `ci/`, `chore/`, `revert/`
* **Commit Frequency & Verification:** Commit each change or group related commits. Do not wait for the entire session to finish. Always check the diff before creating a commit.
* **Pull Requests (PR):** PRs must be opened sequentially in the correct order. Always ask the user for permission before creating a PR.

# Commit Message Conventions (STRICT)

Commits MUST follow the Conventional Commits specification. Commit messages must be plain and contain no links; do not reference pull requests or issues with #.

**Structure**
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]

**Types**
* `fix:` Patches a bug (PATCH).
* `feat:` Introduces a new feature (MINOR).
* `BREAKING CHANGE:` Introduces a breaking API change (MAJOR).
* Other supported types: `build:`, `chore:`, `ci:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`

**Examples**
* `feat(api)!: send an email to the customer when a product is shipped`
* `fix: prevent racing of requests`
* `chore(rojo): initial project structure`
