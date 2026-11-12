---
name: next
description: Execute the next approved, unblocked backend task from docs/PROGRESS.md end to end (one task only), with tests, verification, review and an evidence-based progress update.
disable-model-invocation: true
---
# /next — execute one approved task

Do exactly one coherent task. Stop early and report if any step is blocked; never skip a gate.

## 1. Orient (cheap, no repo-wide scans)
- Read `docs/PROGRESS.md`. Take the first task under **Next up** whose status is `approved` and whose dependencies are done. If none is approved, stop and ask the user which task to approve; don't pick one yourself.
- Read only that task's section in `docs/BACKEND-ROADMAP.md`, plus the ADRs it references.
- Run `git status -sb` and `git branch --show-current`:
  - Work must be on the milestone branch named in PROGRESS (create it from `backend/development` if missing). Never `main`.
  - A dirty tree that isn't yours: stop and report.

## 2. Inspect
- Read the relevant contracts in `docs/API-CONTRACTS.md`, then only the files the task touches (grep and read line ranges). Area rules in `.claude/rules/` load automatically for those paths; follow them.

## 3. Implement
- Make the smallest coherent production change that meets the task's acceptance criteria. Preserve existing behaviour and response shapes unless the task changes them.
- Schema changes go through `npm run db:migrate:dev -- --name <change>` on the local disposable DB only.

## 4. Test
- Add or update tests first or alongside: regression test for fixes, contract tests for routes, integration tests for state transitions.
- Run focused tests while iterating: `npx vitest run <file>`.

## 5. Verify
- Run `/verify` (or follow `.claude/skills/verify/SKILL.md`). Any failure blocks completion: fix it, or report it as a blocker and leave the task `in_progress`.

## 6. Review
- Run `/review` on the diff. Fix every high or medium finding, or record why it is deferred.

## 7. Record
- Update `docs/PROGRESS.md`: move the task to Done with evidence (commands run plus summary lines, commit SHA), set the next task, and list blockers. Keep the file under ~80 lines; move older history to `docs/BACKEND-ROADMAP.md` completion evidence.
- Update `docs/API-CONTRACTS.md` / ADRs if contracts or decisions changed.
- Commit on the milestone branch with a descriptive message. Don't push, merge or deploy unless the user asked in this session.

## 8. Hand off (≤12 lines)
What changed (files) · checks run with results · what's unverified · next task · anything needing a user decision.
