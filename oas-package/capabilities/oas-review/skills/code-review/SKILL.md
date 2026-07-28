---
name: code-review
description: General code review discipline for reviewing a diff or commit range — correctness, design, readability, tests, and API surface, with severity-ranked, actionable findings. Use when asked to review code changes, a commit, a diff, or a PR for quality.
---

# Code review

Review the CHANGE, not the codebase. The standard (from Google's engineering
practices): approve when the change **improves overall code health**, even if
imperfect — demand blockers, suggest the rest.

## Pass order (read the diff twice)

**Pass 1 — does it work?**
- Correctness: logic errors, off-by-one, inverted conditions, wrong operator.
- Edge cases: empty/null/undefined inputs, zero/negative counts, unicode,
  concurrent access, timeouts, partial failure mid-operation.
- Error handling: swallowed exceptions, missing cleanup on the error path,
  errors that lie about the cause. Every catch must justify itself.
- State: mutation of shared state, stale caches, ordering assumptions.
- Resource lifecycle: files/handles/processes/listeners opened but not closed.

**Pass 2 — should it be this way?**
- Design: is this the simplest change that solves the problem? Flag
  speculative generality and dead configurability.
- Consistency: does it follow the codebase's existing patterns, naming, and
  error conventions? (Local consistency beats personal preference.)
- Readability: could a maintainer six months from now follow it without the
  PR description? Names carry meaning; comments explain WHY, not what.
- API surface: new exports/flags/config keys are forever — are they earned?
- Tests: does the change carry tests that would FAIL if the logic regressed?
  Tests that mirror the implementation instead of the behavior are findings.
- Performance: only flag measurable problems (N+1, unbounded growth,
  sync-blocking hot paths) — not micro-optimizations.

## Reporting

- Verdict: `APPROVE` / `APPROVE WITH NITS` / `NEEDS CHANGES`.
- Each finding: `severity — file:line — what + why + concrete fix`.
  Severities: **blocker** (wrong/unsafe/regression), **important** (should
  fix before merge), **nit** (better, not required — prefix "Nit:").
- Ask questions where intent is unclear instead of asserting a fault.
- Do not pad: no restating the diff, no praise quotas, no style opinions a
  formatter could hold. If it's clean, say APPROVE and one line why.
