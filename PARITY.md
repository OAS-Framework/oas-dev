# oas.dev default profile — resolved-config parity with the framework repo

The `oas.dev` default profile is not a minimal illustration. Adopted as an
editable snapshot at a non-Git development workspace root, its resolved behavior
**inside the child `oas/` framework repo** mirrors the framework repository's
historical `oas-config.yaml` for the existing `framework-authors` and
`developers` families, then adds the approved `package-maintainers` extensions.

It is the **complete setup artifact**: `oas init --package oas.dev` acquires and
locks the closure, validates this profile against the closure providers, and
snapshots it whole as the root `oas-config.yaml`; a bare `oas install` then
reconciles. There is no manual post-adoption assembly. A closer child-repo
config exists only for truly repo-specific policy (the framework injection),
never to reconstruct common OAS development policy. The end-to-end sequence is
exercised by `scripts/consumer-acceptance.mjs` (live, released kernel) and
`test/oas-dev-consumer.test.mjs` (structural, today).

Parity is proven mechanically by `test/oas-dev-parity.test.mjs`, which resolves
three fixtures with a dependency-free config reader and compares the effective
per-family view:

- `test/fixtures/legacy-framework-oas-config.yaml` — the legacy behavioral
  baseline (the framework repo's historical config; the deployment-local team id
  is omitted, and messaging is not declared because it came from the laptop's
  outer config).
- `configs/default/oas-config.yaml` — the shipped portable root profile.
- `test/fixtures/framework-child-oas-config.yaml` — the closer override the
  `oas/` repo keeps after migration.

`adopted = deepMerge(rootProfile, frameworkChild)` is the resolution inside
`oas/`. For `framework-authors` and `developers`, `adopted` equals the legacy
baseline on: knowledge = `oas.okf`, tasks = `none`, authoring → framework
authors, review → developers, worktree work-mode, and the
`injects/framework-workspace.md` instruction injection.

## Preserved (no policy loss)

| Behavior | Legacy | Adopted (root ⊕ oas/ child) |
| --- | --- | --- |
| framework-authors family + intent | present | present (same description) |
| developers family + intent | present | present (same description) |
| knowledge layer | `oas.okf` | `oas.okf` |
| tasks layer | `none` | `none` |
| authoring assignment | framework-authors | framework-authors (+ package-maintainers) |
| review assignment | developers | developers (+ package-maintainers) |
| worktree work-mode | declared | declared |
| default OAS policy (`oas:`) | present | present |
| framework-workspace injection **inside `oas/`** | root config | child `oas/` config (closer) |
| identity/team **name** | `oas-framework` | `oas-framework` (preserved — the workspace changes scope, not team identity) |

## Intentional deltas (each approved; none silent)

1. **No machine state in the package** — the resolved provider `team.id` and any account/host path are omitted from the shipped profile; local onboarding/adoption binds the existing provider team identity into the local snapshot only. (`test`: profile has no `id`.) The team NAME `oas-framework` is retained exactly.
2. **Messaging made explicit** — legacy declared no messaging in-config and
   inherited aweb from the laptop's outer config; the portable root declares
   `messaging: oas.aweb` explicitly. This preserves the *actual* runtime
   behavior (aweb) while removing the dependency on an outer config that does
   not exist at a fresh workspace root.
3. **`package-maintainers` family added** — with the owner description, assigned
   to both `oas.authoring` and `oas.review`.
4. **Released package provenance** — providers resolve `from: installed` from the
   workspace's installed **released** closure (oas.dev's catalog dependency
   selectors `oas.okf@…`, `oas.aweb@…`, `oas.authoring@…`), not the framework's
   bundled in-repo capabilities.

## Layering rule (why the injection stays in the child `oas/` config)

`injects/framework-workspace.md` is specific to the framework repository. It must
**not** be placed in the portable root profile:

- it would apply to every sibling package expert (`oas-okf-expert`, …), which is
  wrong — those experts steward their own repos, not the framework; and
- the path is repo-relative and would not resolve from a non-Git workspace root.

So it lives in the `oas/` repo's own (closer) config. The parity test asserts the
root profile carries no `agents-md-injection`, that the `oas/` child config
carries the framework injection, and that a package expert resolving in a sibling
repo (root profile alone) gets `frameworkInjection = null`. The acceptance
property is *effective parity inside `oas/`*, not copying a repo-relative path
into a root where it cannot resolve or would mis-target siblings.

## Live equivalence at migration time

The fixture comparison is portable and runs in the standalone repo. A live
`oas doctor --json` equivalence check (legacy framework-repo resolution vs
adopted-root + child-repo resolution, with the released capabilities installed)
is part of the post-publication workspace probe — it requires the released
capabilities to be installed in the workspace, so it is run by the operator once
the non-Git workspace is assembled (checklist step B9).
