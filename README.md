# oas-dev

Official OAS-project development policy package. It combines:

- the independently targetable `oas.review@2.0.0` capability — its ephemeral
  reviewer agent and the code/security review skills; and
- a reference `default` workspace **config template** for developing OAS itself,
  with framework-author, developer, and official-package-maintainer agent
  families.

The distribution package is `oas.dev@2.0.0` on the **0.20 capability-materialization
contract** (`compatibility.oas: ">=0.20.0"`). The inner capability keeps its own
`oas.review` identity, and **this release is where the two adopt lockstep
versioning**: `oas.review` moves 1.2.0 → 2.0.0 to match the package. The kernel
does not require that — a lock row and a `--json` envelope name the two versions
separately — so it is a convention this repository enforces, from 2.0.0 onward,
in `scripts/validate-manifests.mjs`.

## What changed in 2.0.0

The 0.20 kernel made the package/capability boundary explicit, and this release
adopts the canonical shape rather than the readable-but-deprecated one:

| | v1.0.0 (0.19) | v2.0.0 (0.20) |
| --- | --- | --- |
| template declaration | `configs` | **`configTemplates`** (the deprecated key may not coexist with it) |
| template location | `configs/default/oas-config.yaml` | **`config-templates/default/oas-config.yaml`** |
| capability root | `capabilities/oas-review` | unchanged — a **dedicated** root, now mandatory beside `configTemplates` |
| exported capability version | `oas.review@1.2.0` (versioned independently) | **`oas.review@2.0.0`** — the package/capability lockstep starts here |
| dependencies | `oas.okf@v1.4.1`, `oas.aweb@v1.8.0`, `oas.authoring@v1.0.0` | **`oas.okf@v2.0.0`, `oas.aweb@v2.0.0`, `oas.authoring@v2.0.0`** |
| kernel floor | `>=0.19.0` | **`>=0.20.0`** |

The template's **bytes did not change** — only its path did. That is asserted by
sha256 in `test/oas-dev-parity.test.mjs`, so the 0.20 restructure cannot quietly
become a policy edit; if the profile itself ever changes, the parity argument in
[`PARITY.md`](PARITY.md) is what has to be re-made.

**`v1.0.0` stays published and untouched** for deployments still on a 0.19
kernel. It is not deprecated, not retagged and not amended: a 0.19 consumer
resolving `oas.dev@v1.0.0` gets exactly the tree it always got. v2.0.0 refuses to
install below 0.20.0 rather than degrading, which is why both tags exist.

## Not part of default init

`oas.dev` is for contributors and maintainers working on the OAS project. It is
**not** part of OAS's default initialization profile and must never be applied
implicitly.

## Install spellings the released kernel accepts

A package source has a grammar (`parsePackageSource`, engine contract §1). Every
spelling below is verified against the **released kernel's own parser** by the
consumer probe — not against a description of it — and the offline suite
(`test/readme-install-sources.test.mjs`) re-reads this file to prove no unpinned
or lock-shaped spelling creeps back in.

| Spelling | Parser rule it satisfies |
| --- | --- |
| `oas.dev@v2.0.0` | official catalog id: matches the catalog-id alphabet `[a-z0-9][a-z0-9._-]*` with an `@selector`. The selector **overrides the catalog entry's ref**, which is what makes it work today (below). |
| `https://github.com/OAS-Framework/oas-dev.git@v2.0.0` | raw Git URL: an `http(s)`/`ssh`/`git@`/`file` prefix, with the ref split off at the last `@` that follows the last `/`. No `#` fragment, so the package root is the default `oas-package/`. |
| `git:github.com/OAS-Framework/oas-dev@v2.0.0` | Git shorthand: `git:host/org/repo[@ref]` — exactly three slash-separated, non-empty segments. Expands to the `https://…/oas-dev.git` URL above. |
| `https://github.com/OAS-Framework/oas-dev.git@v2.0.0#oas-package` | the same raw URL with the contained package root named explicitly. The `#path` fragment is split off **before** ref parsing, so it can never be mistaken for part of the ref. Equivalent to row 2, since `oas-package` is the default. |
| `path:/absolute/path/to/oas-dev/oas-package` | local path: acquisition is **exact-directory**, so the path names the payload root `oas-package/`, not the repository root. Relative spellings resolve against the process working directory, not `--dir`. Contributors only — a local path pins a working tree, not a release. |

Two spellings that look right and are **refused**, both of them things a lock
prints rather than things you type:

- `catalog:oas.dev@v2.0.0` — `:` is outside the catalog-id alphabet, so the
  parser reaches its final `throw`. Drop the prefix. The released 0.20.0 kernel
  says, verbatim:

  > `"catalog:oas.dev@v2.0.0" is not a git source, local path, or official catalog id`

- `git:https://github.com/OAS-Framework/oas-dev.git@v2.0.0` — after `git:` the
  parser wants `host/org/repo`, and a URL's `//` makes an empty segment. Use the
  raw URL, or the three-segment shorthand. Verbatim:

  > `git shorthand must be git:host/org/repo[@ref][#<path>]: "git:https://github.com/OAS-Framework/oas-dev.git@v2.0.0"`

Both quotes above are the kernel's own strings, character for character —
including the angle-bracketed `<path>` and the offending spec the message echoes
back. The consumer probe compares each one against the message the released
parser actually throws, so a paraphrase here fails the probe rather than
misleading a reader.

**Why the selector is not optional.** The 0.20.0 kernel ships a bundled catalog
in which `oas.dev` still points at `v1.0.0` (and `oas.okf` / `oas.aweb` /
`oas.authoring` at their v1 tags). A bare `oas.dev` therefore installs v1 until
that catalog is refreshed; `oas.dev@v2.0.0` overrides the entry's ref and
installs this release, and this package's own dependency selectors do the same
for the closure.

**And the catalog is not optional either.** It is overridable only through the
`OAS_PACKAGE_CATALOG` environment variable, and an override **REPLACES** the
bundled catalog outright — there is no merge, and a missing or unreadable file
reads as an *empty* catalog. That is a whole-closure concern, not just a matter
of how you spell `oas.dev`: this package's three dependencies
(`oas.okf@v2.0.0`, `oas.aweb@v2.0.0`, `oas.authoring@v2.0.0`) are **catalog
selectors**, and the kernel resolves each of them through whatever catalog is in
force. Against an empty or partial catalog, acquisition fails resolving
`oas.okf@v2.0.0` — and the Git spellings above cannot rescue it, because they
name the ROOT package's source and say nothing about where its dependencies come
from. So a catalog you supply must itself carry `oas.okf`, `oas.aweb` and
`oas.authoring` entries (plus an `oas.dev` entry whenever `oas.dev` is installed
by catalog id rather than by Git URL or path).

A selector is a **Git ref**, not a semver range: `oas.dev@2.0.0` parses, then
fails to resolve, because the tag is `v2.0.0`.

## Set up an OAS development workspace (the template IS the setup)

The `oas.dev` default template is the **complete** OAS development config — the
portable form of the framework repo's own config plus the package-maintainer
extensions — not an illustrative snippet. Setting up a fresh non-Git development
root is two package-native steps; there is no manual config assembly:

```bash
# 1. Acquire + lock oas.dev and its full closure, validate the template against
#    those providers, and snapshot the COMPLETE template as the root config.
oas init --package oas.dev@v2.0.0 --config default --dir /path/to/oas-workspace

# 2. Restore/reconcile the locked closure and nested repo scopes; host/runtime
#    requirements (aweb aw; pi/claude channel) are reported for separate
#    consent — install activates and installs nothing on its own.
oas install --dir /path/to/oas-workspace
```

`--config default` is explicit above and also redundant: the manifest marks
`default` as the package's default template, so `oas init --package` selects it
on its own. Adoption **refuses to overwrite an existing config**
(`E_CONFIG_EXISTS`) rather than merging into one, and the kernel validates the
template *before* anything is committed to the scope: every capability the
template binds `from: installed` must be supplied by this package or by its
dependency closure, `from: path:` is refused outright, and no injection-override
or work-mode setup path may escape the scope. The resulting `oas-config.yaml` is
an ordinary local snapshot you own and edit; `oas config diff` and
`oas config sync` compare it against the recorded adopted base.

The template defines:

- `framework-authors`: `oas.authoring`;
- `developers`: `oas.review`;
- `package-maintainers`: both `oas.authoring` and `oas.review`;
- knowledge through `oas.okf`, messaging through `oas.aweb`, and tasks explicitly
  `none`;
- the worktree work-mode and default OAS policy.

Adopted at the non-Git development root, the template's resolved behavior
**inside the child `oas/` framework repo** mirrors that repository's historical
`oas-config.yaml` for the `framework-authors` and `developers` families, plus the
approved `package-maintainers` extensions. A closer child-repository config is
only for **truly repo-specific** policy that cannot sensibly apply to sibling
packages — the framework instruction injection (`injects/framework-workspace.md`)
stays in the `oas/` repo so it never reaches sibling package experts and its
repo-relative path always resolves. It is **not** for reconstructing common OAS
development policy. Every preserved behavior and every intentional delta
(deployment-specific team id/credentials/paths, the rename, explicit messaging,
the maintainer family, released provenance) is documented in [`PARITY.md`](PARITY.md).

## The closure: three dependencies, and two deliberate absences

`oas.dev` declares exactly three dependencies, each an immutable pinned catalog
selector: `oas.okf@v2.0.0`, `oas.aweb@v2.0.0`, `oas.authoring@v2.0.0`.
Dependencies are package **source specs**, not capability ids; the lock records
them as sorted package ids.

Installing `oas.dev` therefore locks exactly four packages — itself plus those
three — exporting exactly four capabilities: `oas.review`, `oas.okf`, `oas.aweb`
and `oas.authoring`.

**`oas.jira` and `oas.linear` are never dependencies.** The task layer is the
adopter's choice: the template declares `tasks: none`, and an adopter who wants
one installs it themselves.

```bash
oas install oas.jira@v2.0.0 --dir /path/to/oas-workspace
oas use oas.jira --layer tasks --dir /path/to/oas-workspace
```

(A task provider *does* carry an executable surface — `oas.jira` declares a
command and lifecycle hooks — so it needs `oas trust oas.jira` before it runs.
That is the adopter's decision to make, which is precisely why it is not baked
into this package's closure.)

That absence is proven as **policy rather than a catalog gap**: the consumer
probe installs `oas.jira` successfully from the *same* catalog that produced the
four-package closure. An absence a missing catalog entry could explain proves
nothing; an absence beside a demonstrated presence does. The manifest validator
refuses either id in `dependencies` outright.

## Acquire or activate review independently

The inner review capability stays independently targetable once its provider
package is acquired:

```bash
oas install oas.dev@v2.0.0 --dir /path/to/scope
oas use oas.review --type developers --dir /path/to/scope
oas doctor /path/to/scope --soul some-developer-soul
```

**Trust posture: `oas.review` has nothing to trust; the workspace has two things
that do.** Trust in OAS is per capability, never per package, so the closure's
executable surface has to be enumerated capability by capability:

| Capability | Executable surface | `oas trust` |
| --- | --- | --- |
| `oas.review` | none — an agent definition, two skills, one instruction injection | approves nothing; reports *no executable surface (artifact integrity suffices)* |
| `oas.okf` | command namespace `okf` with the `harvest` command, plus the `soul-scaffold` and `spawn` lifecycle hooks | **required** — `oas trust oas.okf` |
| `oas.aweb` | the `aweb` command namespace (`roster`, `setup`), the `aw` dispatch its skills drive, and required `spawn` / `retire` hooks | **required** — `oas trust oas.aweb` |

So a workspace built from this template needs **two** approvals, one per
executable dependency, and each binds to *that capability's own materialized
artifact integrity* — re-materializing one resets only its own approval. Neither
is inherited from the other, and neither is granted by trusting `oas.dev`: there
is no package-level approval to grant.

This is not a formality for the knowledge layer. The OKF protocol these agents
run under ends every commit with `oas okf harvest`, and that command is part of
`oas.okf`'s executable surface: **until `oas trust oas.okf` is given, the harvest
step cannot run and notes never reach the soul.**

`oas.review` remains the exception rather than the rule: it declares no
`commands` and no `hooks`, so `oas trust oas.review` reports that plainly instead
of granting anything, and the lock's `trusted` flag for it stays `false` with no
loss of function. The reviewer delivers its verdict over whatever messaging layer
the deployment configures — this package configures none of its own.

Probe check 7 proves all three outcomes against the released kernel in one run:
`oas.review` approved `[]` / skipped, and `oas.okf` and `oas.aweb` each approved
at their own artifact integrity.

## Development

```bash
npm test
npm run probe
```

`npm test` is a gate *and* the runner: it rebuilds the canonical `scripts` block,
refuses anything else, then runs manifest validation and exactly the suites under
`test/` as argv — never through a shell, never by bare discovery. It is offline,
and it covers both manifests against the vendored 0.20 schemas
([`SCHEMA-STATUS.md`](SCHEMA-STATUS.md)), resource containment, template
portability, the reviewer contract, the exact family-to-capability matrix, the
child-repository override fixture, the structural half of the consumer contract
(`test/oas-dev-consumer.test.mjs`), and the install spellings documented above.

`npm run probe` drives the **published** `@oas-framework/oas` kernel at this
package's declared floor — the v0.20.0 *tag tree* self-reports 0.19.4, so only
the npm release will do — inside a throwaway sandbox with a synthetic `HOME`, a
PATH of refusing stubs, and a synthetic catalog that pins all five official leaf
packages at their immutable v2 tag commits, served from local bare clones. It
proves the closure in both directions, pinned-Git acquisition at the default
package root, `oas init --package` adopting the template byte for byte, exact
restore, the hook-less trust outcome, agent-type resolution and the nested `oas/`
override, scaffold-only spawn and retire, and the v1-lock cutover refusal. It
needs the npm registry, so CI runs it as its own job.
