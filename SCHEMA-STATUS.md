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
| `schemas/oas-lock.schema.json` | `1d070063…4066f25f` | the **real `oas-lock.json` the released kernel writes** for the four-package closure, validated by the consumer probe |

Provenance is **executed, not asserted**: the consumer probe re-hashes every
file in `schemas/` against `docs/` inside the kernel it actually downloaded and
fails on any drift. A vendored copy that quietly diverges would gate this
package against a contract nobody published, which is the one failure mode a
vendored schema has.

**Every one of the four is APPLIED, and their absence is fatal.** Three gate
documents in `npm test`; the lock schema gates the document the released kernel
generates during the probe — the only lock here that was not built by a test to
match its own expectations. The probe additionally seeds five corruptions into
that lock (a malformed payload integrity, the unsupported transitional
package-root shape, a traversal capability root, a missing required field, an
undefined `lockfileVersion`) and requires the schema to catch each, because a
validator that accepts everything passes an "it validates" assertion just as
happily. And `scripts/validate-manifests.mjs` now REQUIRES all four files to
exist and parse: a deleted schema used to switch its validation off silently
while the gate still reported success, which turns a deletion into a green run.

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
form the kernel parses.

`scripts/catalog-selectors.mjs` is the **single definition of that set** and the
assertion that the shipped manifest carries exactly it: three immutable pinned
catalog selectors, as a set, in any order. `scripts/validate-manifests.mjs`
imports the list from there rather than restating it, so the gate and the CI
selector check cannot disagree about what this release pins. It guarantees
exactly one thing, stated narrowly on purpose: **no floating ref, bare id, local
path or unexpected entry can ship in `dependencies`.** It is not a
local→published *mapping* — the pre-publication local form and its `--apply`
rewrite were retired with this release, because the manifest has been in catalog
form since v2.0.0 was cut and code describing the earlier state was dead code
telling the next maintainer something untrue.

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
  (`test/readme-install-sources.test.mjs`), the README's checkable CLAIMS about
  the closure's executable surface, the catalog-override semantics and the
  version jump (`test/readme-claims.test.mjs`), and the kernel-free structural
  half of the consumer contract (`test/oas-dev-consumer.test.mjs`, which mirrors
  the engine's template validation: supplied = own capabilities ∪ dependency
  closure, plus layer agreement).

  The gate also guards its own COVERAGE, against node's discovery rule as
  MEASURED on node 22 rather than as remembered. It walks the repository and
  refuses to run when a file `node --test` would discover sits outside the
  inventory it names as argv. Exactly two prongs are enforced, and nothing
  wider is claimed:

  - **directory** — inside a directory named exactly `test`, at any depth,
    *every* `.js`/`.cjs`/`.mjs`/`.ts`/`.mts`/`.cts` file is discovered, whatever
    its name and however deep below that directory it sits. `lib/test/parser.mjs`
    and `test/helpers/fixture.mjs` are both run by node, so both must be
    inventoried. There is no "helper module" exemption, because there is no
    location under a `test` directory that node leaves alone.
  - **name** — anywhere else, `test`, `test-*` or `*[.-_]test` with one of those
    extensions, matched case-insensitively (node matches file names
    case-insensitively on a case-insensitive filesystem; the gate always does,
    which flags a superset rather than missing one).

  Symlinks are refused in both directions rather than followed: node runs a
  symlinked test FILE, and *nobody* traverses a symlinked DIRECTORY, so suites
  beneath one run nowhere while the tree looks populated. `node_modules`,
  dot-prefixed entries (which node also skips) and other instances' work trees
  under `agents/<soul>/instances/<id>/` are outside the scan — the last because
  they are foreign checkouts at other revisions, which this repository neither
  owns nor may rewrite.

  Each thing the gate refuses is a suite that would silently never execute, and
  green looks identical either way.
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
  own `parsePackageSource`, that every spelling documented as refused is
  refused, and that the refusal messages the README QUOTES are the kernel's own
  strings character for character (a paraphrase reads as documentation and is a
  lie about a program's output); the closure in both directions; that the
  generated `oas-lock.json` satisfies the vendored lock schema, with five seeded
  corruptions proving the schema is gating something; pinned-Git acquisition
  against an ADVANCED branch head; template adoption byte-for-byte; exact
  restore; the hook-less trust outcome for `oas.review` BESIDE the two
  dependencies that do carry an executable surface — and that the README's trust
  posture names each of those by `oas trust <id>`; agent-type resolution and the
  nested `oas/` override; scaffold-only spawn/retire; and the v1-lock
  `legacy-lock` refusal.
  Known released-0.20 kernel defects (the false-orphan `doctor` warning, the
  prototype-garbled config-key diagnostic) are recorded verbatim and worked
  around nowhere.

CI runs the two as separate jobs: the offline gate on every push and pull
request, and the probe in its own job because it needs the npm registry.
