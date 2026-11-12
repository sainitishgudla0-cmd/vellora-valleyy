# AGENTS.md

Instructions for any coding agent working in this repository.

The single source of truth is [`CLAUDE.md`](CLAUDE.md): commands, hard safety rules and links to canonical docs. Area rules live in [`.claude/rules/`](.claude/rules/) (plain Markdown, applicable to any agent).

Minimum contract:
- Read `docs/PROGRESS.md` before starting; update it with evidence when you finish.
- Never touch `main`, production databases, deployments, or live payment configuration.
- `npm run verify` must pass before you claim a change works; report anything you could not run.
