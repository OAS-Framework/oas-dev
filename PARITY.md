# oas.dev default profile — resolved-config parity with the framework repo

The `oas.dev` default profile is not a minimal illustration. Adopted as an
editable snapshot at a non-Git development workspace root, its resolved behavior
**inside the child `oas/` framework repo** mirrors the framework repository's
historical `oas-config.yaml` for the existing `framework-authors` and
`developers` families, then adds the approved `package-maintainers` extensions.

It is the **complete setup artifact**: `oas init --package oas.dev@v2.0.0`
acquires and locks the closure, validates this profile against the closure
providers, and snapshots it whole as the root `oas-config.yaml`; a bare
`oas install` then reconciles. There is no manual post-adoption assembly. A
closer child-repo config exists only for truly repo-specific policy (the
framework injection), never to reconstruct common OAS development policy. The
end-to-end sequence is exercised by `scripts/consumer-probe.mjs` (live, released
kernel) and `test/oas-dev-consumer.test.mjs` (structural, today).

## In 2.0.0 the profile MOVED; it did not CHANGE

The 0.20 contract requires a package's config templates to live under
`config-templates/`, so the file this document argues about now ships at
`oas-package/config-templates/default/oas-config.yaml`. Those are the same bytes
that shipped from `configs/default/oas-config.yaml` at the v1.0.0 tag: the
parity suite pins the template's sha256 and additionally asserts that the
abandoned `configs/` root is gone, so no adopter can reach the old copy and no
edit can hide inside a restructure. Every parity claim below is therefore
inherited from v1.0.0 unchanged. The one thing 2.0.0 does change is *provenance*
— delta 4 — because the dependency selectors that supply the providers moved to
the v2 leaf tags.

Parity is proven mechanically by `test/oas-dev-parity.test.mjs`, which resolves
three fixtures with a dependency-free config reader and compares the effective
per-family view:

- `test/fixtures/legacy-framework-oas-config.yaml` — the legacy behavioral
  baseline (the framework repo's historical config; the deployment-local team id
  is omitted, and messaging is not declared because it came from the laptop's
  outer config).
- `oas-package/config-templates/default/oas-config.yaml` — the shipped portable
  root profile.
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
   selectors, `oas.okf@v2.0.0`, `oas.aweb@v2.0.0` and `oas.authoring@v2.0.0` in
   this release), not the framework's bundled in-repo capabilities. The template
   binds capability IDs, which do not change with the selector, so moving the
   pins from the v1 tags to the v2 tags is a provenance change and not a policy
   change — the resolved per-family view is identical either way.

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
