## Review discipline: oas.review

**After every substantive commit, launch the reviewer** — and, when a knowledge
layer is active, run its promotion step alongside (whatever command that layer
documents; omit the line entirely if you have no knowledge layer):

```bash
<your knowledge layer's promotion command>   # omit when no knowledge layer is active
oas spawn reviewer --work attached --work-dir "$PWD/work" \
  --purpose "<short-sha>" \
  --task "Review commit <sha> on branch <branch>. Report to <your-instance> per your operating loop."
```

- `--purpose "<short-sha>"` gives the reviewer a unique, commit-relevant
  instance name (`reviewer-<short-sha>`); attached mode shares your work tree
  and automatically makes the reviewer your child (attached agents are always
  children of the work-tree owner — no relation flags needed or allowed).
- The reviewer reviews **that commit's diff only** and reports its verdict
  (`APPROVE` / `APPROVE WITH NITS` / `NEEDS CHANGES`) back to you the way your
  deployment delivers messages: over your messaging layer when one is active,
  and otherwise in its own session transcript, which is where you read it.
  When a messaging layer IS active, do not wait actively — finish your turn and
  go idle; the layer wakes you when the verdict arrives. `NEEDS CHANGES` means
  fix, commit, and re-review before the work is ready.
- Do not review your own commits in its place — the point is eyes that are
  not yours.
- Skip only for trivial mechanical commits (typo, lockfile refresh) — when
  in doubt, review.

## Delivery discipline (all OAS developers)

- You work in a dedicated worktree on your own branch. **Main only moves
  through PRs** — never push to main.
- **Single-developer features**: branch from main (`agents/<instance>` or as
  tasked), open the PR yourself (`gh pr create`) when review-clean, then
  **spawn a fresh maintainer instance for it** — one per PR, always, even if
  another oas-expert instance is live:

  ```bash
  oas spawn oas-expert --purpose "pr<n>" --relation parent --relative-to "$OAS_INSTANCE" \
    --task "Maintainer review of PR #<n>: run your pr-review gates. You own this PR to its terminal outcome — on RETURN stay alive and idle for my fix notice, re-review, repeat; on merge/close record the delivery in your stewardship knowledge and retire yourself. Report verdicts to <your-instance>."
  ```

  Go idle for the verdict. **The maintainer instance stays alive across
  RETURN rounds** — when you push fixes, notify the SAME maintainer, continuing
  the existing exchange rather than starting a new one; do not spawn another for
  this PR. You never merge to main
  yourself.

  **Reviewers are the opposite: one per commit, then gone.** The post-commit
  reviewer reviews its one diff, reports its verdict, and retires — it no
  longer exists when you fix its findings. To re-review a fix, spawn a NEW
  reviewer on the fix commit (`--purpose <new-short-sha>`); never message a
  retired reviewer or expect it to follow up.
- **Multi-developer features**: the coordinator owns the feature branch
  (`feature/<name>`) and the PR. Branch `<you>/<name>` **from the feature
  branch**, push your branch, and tell the coordinator when it is ready —
  the coordinator merges, validates, and reviews the integrated state. Never
  merge into the feature branch yourself.
- **If you need another developer's unmerged code, ask the coordinator** —
  never fetch or merge a peer's branch yourself. The coordinator
  lands the dependency on the feature branch and tells you to merge the
  feature branch into yours.
- Quality bar before handing off or opening a PR: the repo's full test/check
  gate green; docs updated with behavior changes.
- While waiting on the reviewer, the coordinator, or a peer: **do not sleep,
  poll, or busy-wait** — go idle. An active messaging layer wakes you when the
  answer arrives; with none, read the reviewer's own session when it finishes.
