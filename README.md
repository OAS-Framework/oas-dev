# oas-dev

Official OAS-project development policy package. It combines:

- the independently targetable `oas.review@1.2.0` capability, including its ephemeral reviewer and code/security review skills; and
- a reference `default` workspace profile for developing OAS itself, with framework-author, developer, and official-package-maintainer agent families.

The distribution package is `oas.dev@1.0.0`; the inner capability intentionally keeps its separate `oas.review@1.2.0` identity and version.

## Not part of default init

`oas.dev` is for contributors and maintainers working on the OAS project. It is **not** part of OAS's default initialization profile and must never be applied implicitly.

The profile recommends OAS knowledge and messaging integrations plus authoring/review policy. Its dependency closure is pinned to the immutable official selectors `oas.okf@v1.4.1`, `oas.aweb@v1.8.0`, and `oas.authoring@v1.0.0`; Jira and Linear remain adopter-selected. `oas.dev` publishes last, after those dependencies. See [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

## Set up an OAS development workspace (the profile IS the setup)

The `oas.dev` default profile is the **complete** OAS development config — the
portable form of the framework repo's own config plus the package-maintainer
extensions — not an illustrative snippet. Setting up a fresh non-Git
development root is two package-native steps; there is no manual config
assembly:

```bash
# 1. Acquire + lock oas.dev and its full closure, validate the profile against
#    those providers, and snapshot the COMPLETE profile as the root config.
oas init --package oas.dev --config default --dir /path/to/oas-workspace
# Until the kernel catalog patch is installed, the equivalent explicit source is:
# https://github.com/OAS-Framework/oas-dev.git@v1.0.0
# with OAS_PACKAGE_CATALOG pointing at the released dependency catalog.

# 2. Restore/reconcile the locked closure and nested repo scopes; host/runtime
#    requirements (aweb `aw`; pi/claude channel) are reported for separate
#    consent — install activates and installs nothing on its own.
oas install --dir /path/to/oas-workspace
```

The closure is `oas.dev` (which exports `oas.review`) plus dependencies
supplying `oas.okf`, `oas.aweb`, and `oas.authoring`. Adoption is explicit and
refuses to overwrite an existing config; the resulting `oas-config.yaml` is an
ordinary local snapshot. Jira/Linear stay absent (tasks `none`) unless the
adopter adds a tasks provider.

The profile defines:

- `framework-authors`: `oas.authoring`;
- `developers`: `oas.review`;
- `package-maintainers`: both `oas.authoring` and `oas.review`;
- knowledge through `oas.okf`, messaging through `oas.aweb`, and tasks explicitly `none`;
- the worktree work-mode and default OAS policy.

Adopted at the non-Git development root, the profile's resolved behavior **inside
the child `oas/` framework repo** mirrors that repository's historical
`oas-config.yaml` for the `framework-authors` and `developers` families, plus the
approved `package-maintainers` extensions. A closer child-repository config is
only for **truly repo-specific** policy that cannot sensibly apply to sibling
packages — the framework instruction injection (`injects/framework-workspace.md`)
stays in the `oas/` repo so it never reaches sibling package experts and its
repo-relative path always resolves. It is **not** for reconstructing common OAS
development policy. Every preserved behavior and every intentional delta
(deployment-specific team id/credentials/paths, the rename, explicit messaging,
the maintainer family, released provenance) is documented in [`PARITY.md`](PARITY.md).

The end-to-end non-Git consumer acceptance test
(`scripts/consumer-acceptance.mjs`) exercises the whole sequence against a
published OAS ≥ 0.19.0 kernel — `oas init --package` → v2 lock graph → adopted
complete root config → bare `oas install` → expected providers/targets via
`oas doctor` → nested `oas/` override → cutover check — and fails closed
(release-pending) below the floor. Its kernel-free structural half
(`test/oas-dev-consumer.test.mjs`) runs today.

## Acquire or activate review independently

The inner review capability remains independently targetable after its provider package is acquired:

```bash
oas install oas.dev --dir /path/to/scope
oas use oas.review --type developers --dir /path/to/scope
oas doctor /path/to/scope --soul <developer-soul>
```

The capability has no commands or lifecycle hooks, so it does not require executable trust. Its reviewer uses the deployment's configured messaging layer to deliver verdicts.

## Development

```bash
npm test
```

The package-local gates validate both manifests, resource containment, the reviewer contract, the exact profile target matrix, and a child-repository override fixture. The released OAS 0.19.0 consumer probe and immutable dependency pins remain external release gates.
