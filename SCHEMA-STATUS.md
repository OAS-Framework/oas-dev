# Schema status

What this repository validates against, where those files came from, and what
is proven by whom.

## The vendored 0.20 schemas and their provenance

`schemas/` holds four JSON Schemas, each a **byte-identical copy of `docs/` in
the published `@oas-framework/oas@0.20.0` npm package** — the released kernel
this package declares as its floor. They are vendored rather than resolved at
runtime so `npm test` stays offline and so a schema change arrives as a
reviewable diff instead of as a CI weather event.

| Vendored file | sha256 | Gates |
| --- | --- | --- |
| `schemas/oas-package.schema.json` | `95b2347a…40339993` | `oas-package/oas-package.json` |
| `schemas/capability-manifest.schema.json` | `165ebf36…cecf852b` | `oas-package/capabilities/oas-review/oas.json` |
| `schemas/oas-config.schema.json` | `43333d3f…5023c7b8` | the shipped config template, parsed with the kernel's own YAML subset |
| `schemas/oas-lock.schema.json` | `1d070063…4066f25f` | the lock shape the consumer probe asserts |

Provenance is **executed, not asserted**: the consumer probe re-hashes every
file in `schemas/` against `docs/` inside the kernel it actually downloaded and
fails on any drift. A vendored copy that quietly diverges would gate this
package against a contract nobody published, which is the one failure mode a
vendored schema has.

Note that the v0.20.0 *tag tree* self-reports `0.19.4`; only the published npm
build reports `0.20.0`. Every provenance and probe statement here means the npm
build.

## What the 0.20 contract requires of this package

The canonical shape, as the released kernel enforces it:

- **`configTemplates`, not `configs`.** The 0.19 spelling remains *readable* so
  immutable published tags stay consumable, but a package on the 0.20 contract
  emits the canonical key, and the kernel refuses a manifest carrying both.
  `scripts/validate-manifests.mjs` reports each of those separately.
- **Template paths live under `config-templates/`.** This package ships exactly
  one: `config-templates/default/oas-config.yaml`, marked `default: true`.
- **Dedicated capability roots are mandatory** once `configTemplates` ships. A
  `"."` capability root is read-compatibility for already-published packages and
  is never authored here.
- **Dependencies are package source specs**, not capability ids. The catalog
  form is `<id>@<selector>`, where the selector overrides the catalog entry's
  ref; Git dependencies must be pinned. The lock records dependencies as sorted
  package ids.
- **Templates are validated before anything is committed** to the scope: every
  `from: installed` capability must be supplied by the package or its dependency
  closure, `from: path:` is refused, and injection-override / work-mode setup
  paths may not escape the scope.

## Dependency selectors (no placeholders)

`oas.dev@2.0.0` pins `oas.okf@v2.0.0`, `oas.aweb@v2.0.0` and
`oas.authoring@v2.0.0` — the released sibling v2 tags, in exactly the catalog
form the kernel parses. `scripts/catalog-selectors.mjs` remains the deterministic
local→published mapping and accepts the exact published form, so the pre-release
local-path spelling can never be published by accident.

`oas.jira` and `oas.linear` are adopter-selected task providers and are **never**
dependencies; the validator rejects either id in `dependencies` outright, and the
probe proves the absence is policy by installing `oas.jira` from the same catalog
that produced the four-package closure.

The kernel does not require a package's version to equal its exported
capability's version — that lockstep is this repository's convention, enforced
by `scripts/validate-manifests.mjs`, so a lock row and a `--json` envelope name
`oas.dev@2.0.0` and `oas.review@2.0.0` separately and they always agree.

## The catalog, and why the README documents a selector

The catalog is a JSON document — `{packages: {id: {url, ref?, path?}},
capabilities: {capId: pkgId}}` — overridable **only** through the
`OAS_PACKAGE_CATALOG` environment variable; a missing file reads as an empty
catalog. The published 0.20.0 kernel bundles one in which `oas.dev` still points
at `v1.0.0`, so a bare `oas.dev` installs the previous release until that catalog
is refreshed. The probe reads that entry from the kernel itself and fails if it
ever names v2.0.0, which is the signal to rewrite the README's install section
rather than let it go stale.

## What proves what

- **`npm test` (offline, gate + runner).** `scripts/check-test-scripts.mjs`
  rebuilds the canonical `scripts` block, refuses anything else, then runs
  manifest validation and exactly the suites under `test/` as argv. It covers
  both manifests against the schemas above, resource containment, template
  portability through the shared predicate (`scripts/lib/config-portability.mjs`),
  the reviewer contract, the exact family-to-capability matrix, forbidden
  deployment-specific fields, resolved-config parity with the framework repo
  (`test/oas-dev-parity.test.mjs` + `PARITY.md`), a closer child-repository
  fixture used only for repo-specific policy, the README's install spellings
  (`test/readme-install-sources.test.mjs`), and the kernel-free structural half
  of the consumer contract (`test/oas-dev-consumer.test.mjs`, which mirrors the
  engine's template validation: supplied = own capabilities ∪ dependency
  closure, plus layer agreement).
- **`npm run probe` (released kernel, hermetic).** `scripts/consumer-probe.mjs`
  npm-installs the PUBLISHED `@oas-framework/oas` at the version derived from
  this package's `compatibility.oas` floor, invokes it by absolute path under a
  synthetic HOME and a PATH built only from provisioned directories (every
  runtime, `aw`, `tmux` and `oas` itself is a refusing, recording stub), and
  drives it against a SYNTHETIC CATALOG pinning all five official leaf packages
  at their immutable v2 tag commits, served from local `file://` bare clones —
  no network beyond the kernel download, and no dependence on the machine's own
  deployment. It proves: schema provenance and the bundled-catalog fact above;
  that every install spelling the README documents is accepted by the kernel's
  own `parsePackageSource` and every spelling documented as refused is refused;
  the closure in both directions; pinned-Git acquisition against an ADVANCED
  branch head; template adoption byte-for-byte; exact restore; the hook-less
  trust outcome for `oas.review`; agent-type resolution and the nested `oas/`
  override; scaffold-only spawn/retire; and the v1-lock `legacy-lock` refusal.
  Known released-0.20 kernel defects (the false-orphan `doctor` warning, the
  prototype-garbled config-key diagnostic) are recorded verbatim and worked
  around nowhere.

CI runs the two as separate jobs: the offline gate on every push and pull
request, and the probe in its own job because it needs the npm registry.
