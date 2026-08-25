import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ADVERSARIAL fixtures for scripts/validate-manifests.mjs.
 *
 * Every case builds a THROWAWAY package in a temp directory — the real
 * validator, the real schemas, the real portability predicate, a synthetic
 * payload — and runs the gate as a child process, so what is exercised is the
 * shipped script rather than a re-implementation of its rules.
 *
 * Each guard is proved in its NEGATIVE direction (the defect is rejected) and,
 * wherever a rule broad enough to catch the defect could start rejecting
 * legitimate content, in its POSITIVE direction too. A guard asserted in one
 * direction only is satisfied just as well by a validator that rejects
 * everything as by one that works.
 *
 * The BASELINE fixture is the shipped shape: package oas.dev 2.0.0, one
 * dedicated capability root exporting oas.review 2.0.0, both floors at
 * >=0.20.0, the three pinned dependency selectors, and a byte copy of the
 * SHIPPED config template. It must pass — which also makes this suite a
 * standing check that the template we distribute is portable.
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAYLOAD = join(REPO, "oas-package");
const CAPABILITY_DIR = "capabilities/oas-review";
const TEMPLATE_PATH = "config-templates/default/oas-config.yaml";

/** The template we actually ship, byte for byte. */
const SHIPPED_TEMPLATE = readFileSync(join(PAYLOAD, ...TEMPLATE_PATH.split("/")), "utf8");

const CANONICAL_DEPENDENCIES = ["oas.okf@v2.0.0", "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"];

/**
 * Build a throwaway repository around the REAL validator and run it.
 *
 * @param t node:test context (the fixture is removed when the test finishes)
 * @param capabilityDirs declared capability roots
 * @param packageExtras merged over the canonical package manifest; a key set to
 *   `undefined` is DROPPED, because JSON.stringify omits undefined values —
 *   that is how a fixture removes `capabilities` or `configTemplates`
 * @param capability merged over the canonical capability manifest
 * @param template contents for the default template, or null to write none
 * @param files extra files, keyed by payload-relative path
 * @param links symlinks [linkPath, targetRelativeToPayload]
 * @param outsideLinks symlinks [linkPath, targetRelativeToFixtureRoot] — these
 *   escape the package payload entirely
 */
function runFixture(t, {
  capabilityDirs = [CAPABILITY_DIR],
  packageExtras = {},
  capability = {},
  template = SHIPPED_TEMPLATE,
  files = {},
  links = [],
  outsideLinks = [],
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "oas-dev-manifest-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts", "lib"), { recursive: true });
  mkdirSync(join(fixture, "schemas"), { recursive: true });
  mkdirSync(join(fixture, "oas-package"), { recursive: true });

  copyFileSync(join(REPO, "scripts", "validate-manifests.mjs"), join(fixture, "scripts", "validate-manifests.mjs"));
  for (const lib of ["kernel-yaml.mjs", "config-portability.mjs"]) {
    copyFileSync(join(REPO, "scripts", "lib", lib), join(fixture, "scripts", "lib", lib));
  }
  for (const schema of ["oas-package", "capability-manifest"]) {
    copyFileSync(join(REPO, "schemas", `${schema}.schema.json`), join(fixture, "schemas", `${schema}.schema.json`));
  }

  const write = (relative, contents) => {
    const path = join(fixture, "oas-package", relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  write("oas-package.json", JSON.stringify({
    package: "oas.dev",
    version: "2.0.0",
    description: "Adversarial manifest-validation fixture.",
    compatibility: { oas: ">=0.20.0" },
    capabilities: capabilityDirs,
    configTemplates: {
      default: { path: TEMPLATE_PATH, description: "OAS development workspace root", default: true },
    },
    dependencies: [...CANONICAL_DEPENDENCIES],
    ...packageExtras,
  }, null, 2) + "\n");

  if (template !== null) write(TEMPLATE_PATH, template);
  for (const [relative, contents] of Object.entries(files)) write(relative, contents);

  for (const capabilityDir of capabilityDirs) {
    if (typeof capabilityDir !== "string" || capabilityDir.includes("..")) continue;
    write(join(capabilityDir, "oas.json"), JSON.stringify({
      capability: "oas.review",
      version: "2.0.0",
      compatibility: { oas: ">=0.20.0" },
      description: "Adversarial manifest-validation fixture capability.",
      requires: [],
      ...capability,
    }, null, 2) + "\n");
  }

  const link = (linkPath, target) => {
    const path = join(fixture, "oas-package", linkPath);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  };
  for (const [linkPath, target] of links) link(linkPath, join(fixture, "oas-package", target));
  for (const [linkPath, target] of outsideLinks) link(linkPath, join(fixture, target));

  return spawnSync(process.execPath, [join(fixture, "scripts", "validate-manifests.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// The baseline. Everything below is this fixture with exactly one thing wrong.
// ---------------------------------------------------------------------------

test("the shipped shape — one dedicated capability root, one canonical template — passes", (t) => {
  const result = runFixture(t, {});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 capability manifest\(s\), and 1 config template\(s\)/);
});

// ---------------------------------------------------------------------------
// Capability enumeration: exactly one DEDICATED root.
// ---------------------------------------------------------------------------

test("validator rejects a package that enumerates no capability", (t) => {
  // Config-only packages do not exist: acquisition materializes capabilities,
  // and a package exporting none has nothing to install.
  const result = runFixture(t, { capabilityDirs: [], packageExtras: { capabilities: undefined } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exports exactly one capability \(oas\.review\); found 0 declared capability root\(s\)/);
});

test("validator rejects a second capability root", (t) => {
  const result = runFixture(t, { capabilityDirs: [CAPABILITY_DIR, "capabilities/oas-extra"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exports exactly one capability \(oas\.review\); found 2 declared capability root\(s\)/);
});

test('validator rejects the package root "." as a capability root', (t) => {
  // Released 0.20 refuses "." as soon as configTemplates ships, because the
  // materialized artifact would be the whole package rather than a capability.
  const result = runFixture(t, { capabilityDirs: ["."] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a valid capability root once configTemplates ships/);
});

// ---------------------------------------------------------------------------
// Template descriptors: canonical spelling, canonical location, one default.
// ---------------------------------------------------------------------------

test('validator rejects a manifest carrying both "configTemplates" and "configs"', (t) => {
  const result = runFixture(t, {
    packageExtras: {
      configTemplates: { default: { path: TEMPLATE_PATH, default: true } },
      configs: { legacy: { path: TEMPLATE_PATH } },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /declares both "configTemplates" and the deprecated "configs" spelling/);
});

test('validator rejects the deprecated "configs" spelling on its own', (t) => {
  // Readable for immutable 0.19 tags; never authored by a package on the 0.20
  // contract, where the canonical spelling is what the kernel looks for.
  const result = runFixture(t, {
    packageExtras: { configTemplates: undefined, configs: { default: { path: TEMPLATE_PATH, default: true } } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uses the DEPRECATED 0\.19 spelling/);
});

test("validator rejects a template that lives outside config-templates/", (t) => {
  // The location is contract, not tidiness: isCanonicalTemplatePath in the
  // released kernel refuses to read a descriptor pointing anywhere else — which
  // is exactly the v1 location this release had to move away from.
  const result = runFixture(t, {
    packageExtras: { configTemplates: { default: { path: "configs/default/oas-config.yaml", default: true } } },
    template: null,
    files: { "configs/default/oas-config.yaml": SHIPPED_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live under "config-templates\/"/);
});

test("validator rejects a template path that climbs out of config-templates/", (t) => {
  const result = runFixture(t, {
    packageExtras: { configTemplates: { default: { path: "config-templates/../oas-config.yaml", default: true } } },
    files: { "oas-config.yaml": SHIPPED_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live under "config-templates\/" with a contained file path/);
});

test("validator rejects two templates both marked default", (t) => {
  // `oas init --package` picks the default without --config; two of them makes
  // the adopter's deployment depend on map ordering.
  const result = runFixture(t, {
    packageExtras: {
      configTemplates: {
        default: { path: TEMPLATE_PATH, default: true },
        other: { path: "config-templates/other/oas-config.yaml", default: true },
      },
    },
    files: { "config-templates/other/oas-config.yaml": SHIPPED_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most one config template may be marked default/);
});

test("validator accepts a second template that is NOT marked default", (t) => {
  // Non-vacuity for the rule above: more than one template is legal; more than
  // one DEFAULT is not.
  const result = runFixture(t, {
    packageExtras: {
      configTemplates: {
        default: { path: TEMPLATE_PATH, default: true },
        other: { path: "config-templates/other/oas-config.yaml" },
      },
    },
    files: { "config-templates/other/oas-config.yaml": SHIPPED_TEMPLATE },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 config template\(s\)/);
});

// ---------------------------------------------------------------------------
// Dependencies: package SOURCE SPECS, exactly three, each immutably pinned.
// ---------------------------------------------------------------------------

test("validator rejects a missing dependency", (t) => {
  const result = runFixture(t, { packageExtras: { dependencies: ["oas.okf@v2.0.0", "oas.aweb@v2.0.0"] } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing \["oas\.authoring@v2\.0\.0"\]/);
});

test("validator rejects an extra dependency", (t) => {
  const result = runFixture(t, {
    packageExtras: { dependencies: [...CANONICAL_DEPENDENCIES, "oas.desktop@v2.0.0"] },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected \["oas\.desktop@v2\.0\.0"\]/);
});

for (const [label, spec] of [
  ["a floating catalog ref", "oas.okf@main"],
  ["a bare package id with no selector at all", "oas.okf"],
  ["an unpinned git source spec", "git:github.com/OAS-Framework/oas-okf"],
  ["a git URL whose @ref is a branch", "https://github.com/OAS-Framework/oas-okf.git@main"],
  ["a local path into the developer's own workspace", "../../oas-okf/oas-package"],
]) {
  test(`validator rejects ${label} as a dependency`, (t) => {
    // A dependency is the SOURCE of bytes that end up in every adopter's
    // closure. Anything that can resolve differently tomorrow is refused.
    const result = runFixture(t, {
      packageExtras: { dependencies: [spec, "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"] },
    });
    assert.equal(result.status, 1, `${label} must not ship as a dependency`);
    assert.match(result.stderr, /is not one of this release's pinned catalog selectors/);
  });
}

for (const [label, spec] of [
  ["oas.jira", "oas.jira@v2.0.0"],
  ["oas.linear", "oas.linear@v2.0.0"],
  ["a jira dependency wearing a git source spec", "git:github.com/OAS-Framework/oas-jira@v2.0.0"],
]) {
  test(`validator refuses ${label} BY NAME, not merely as an unexpected entry`, (t) => {
    // The task layer is the adopter's choice. Depending on a provider would drag
    // it into every oas.dev closure, so the diagnostic has to say why rather
    // than reading as "wrong version".
    const result = runFixture(t, {
      packageExtras: { dependencies: [...CANONICAL_DEPENDENCIES, spec] },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /names an adopter-selected task provider/);
  });
}

test("validator rejects a repeated dependency", (t) => {
  const result = runFixture(t, {
    packageExtras: { dependencies: [...CANONICAL_DEPENDENCIES, "oas.okf@v2.0.0"] },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must contain unique items|must not repeat a dependency/);
});

test("dependency ORDER carries no meaning", (t) => {
  // The lock records dependencies as sorted package ids, so ordering here is not
  // something a reviewer should have to check — and the gate must not invent a
  // rule the kernel does not have.
  const result = runFixture(t, {
    packageExtras: { dependencies: ["oas.authoring@v2.0.0", "oas.okf@v2.0.0", "oas.aweb@v2.0.0"] },
  });
  assert.equal(result.status, 0, result.stderr);
});

// ---------------------------------------------------------------------------
// The version lockstep (repo convention) and the compatibility floor.
// ---------------------------------------------------------------------------

test("validator rejects package 2.0.0 shipping capability oas.review 1.2.0", (t) => {
  // The KERNEL is content for these to differ; this repository is not, because
  // "oas.dev 2.0.0" must name exactly one reviewable artifact. The diagnostic
  // says which of the two rules it is.
  const result = runFixture(t, { capability: { version: "1.2.0" } });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /oas\.review must be 2\.0\.0 — repo convention keeps the capability in lockstep with package 2\.0\.0 \(found "1\.2\.0"\)/,
  );
});

test("validator rejects a package version that is not this release", (t) => {
  const result = runFixture(t, { packageExtras: { version: "1.0.0" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be 2\.0\.0 — the 0\.20 capability-materialization release/);
});

test("validator rejects a capability id other than oas.review", (t) => {
  const result = runFixture(t, { capability: { capability: "oas.reviewer" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /oas\.dev exports capability oas\.review/);
});

for (const [label, floor] of [
  ["a pre-0.20 floor", ">=0.19.0"],
  ["a caret range", "^0.20.0"],
  ["an exact pin", "0.20.0"],
]) {
  test(`validator rejects ${label} on the package manifest`, (t) => {
    // The canonical configTemplates / dedicated-root contract landed in 0.20.0.
    // Anything looser lets the package be acquired by a kernel that cannot
    // materialize it; anything narrower strands adopters on later kernels.
    const result = runFixture(t, { packageExtras: { compatibility: { oas: floor } } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be ">=0\.20\.0"/);
  });
}

test("validator rejects a capability floor that disagrees with the package floor", (t) => {
  const result = runFixture(t, { capability: { compatibility: { oas: ">=0.19.0" } } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be ">=0\.20\.0", matching the package floor/);
});

// ---------------------------------------------------------------------------
// Self-containment, and the kernel's resource-kind ASYMMETRY.
// ---------------------------------------------------------------------------

test("validator rejects a capability resource that escapes its own capability root", (t) => {
  // Inside the PAYLOAD but outside the CAPABILITY: package-only bytes are not
  // installed bytes, so the materialized artifact would be missing its inject.
  const result = runFixture(t, {
    capability: { inject: "shared/inject.md" },
    files: { "shared/inject.md": "# package-only\n" },
    links: [[`${CAPABILITY_DIR}/shared`, "shared"]],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injection path escapes its capability root after symlink resolution/);
});

test("validator rejects an escaping symlink buried INSIDE a declared skill tree", (t) => {
  // The declared path itself resolves fine; a link one level down does not, and
  // materialization copies that link's target into the adopter's deployment.
  const result = runFixture(t, {
    capability: { skills: ["skills/demo"] },
    files: { [`${CAPABILITY_DIR}/skills/demo/SKILL.md`]: "---\nname: demo\ndescription: fixture\n---\n" },
    outsideLinks: [[`${CAPABILITY_DIR}/skills/demo/leak.mjs`, "scripts/validate-manifests.mjs"]],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill tree contains a path escaping its capability root/);
});

test("validator rejects a broken symlink inside a declared skill tree", (t) => {
  // A dangling target is copied as a dangling target: the failure then surfaces
  // in the adopter's deployment as a missing skill, not as a bad package.
  const result = runFixture(t, {
    capability: { skills: ["skills/demo"] },
    files: { [`${CAPABILITY_DIR}/skills/demo/SKILL.md`]: "---\nname: demo\ndescription: fixture\n---\n" },
    links: [[`${CAPABILITY_DIR}/skills/demo/dangling.md`, "nothing-here.md"]],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken symlink/);
});

test("validator accepts a contained skill tree that uses an INTERNAL symlink", (t) => {
  // Non-vacuity: containment is about escaping, not about symlinks.
  const result = runFixture(t, {
    capability: { skills: ["skills/demo"] },
    files: {
      [`${CAPABILITY_DIR}/skills/demo/SKILL.md`]: "---\nname: demo\ndescription: fixture\n---\n",
      [`${CAPABILITY_DIR}/skills/demo/reference.md`]: "# reference\n",
    },
    links: [[`${CAPABILITY_DIR}/skills/demo/alias.md`, `${CAPABILITY_DIR}/skills/demo/reference.md`]],
  });
  assert.equal(result.status, 0, result.stderr);
});

// The kernel treats the two resource kinds differently, and a validator that
// collapses them to "walk it if it is a directory" silently accepts a FILE
// under agents[]. Both directions are pinned, because a lone agents[] test
// reads as "directories required" and invites making skills[] strict to match.
test("validator rejects an agents[] entry that is a file", (t) => {
  const result = runFixture(t, {
    capability: { agents: ["reviewer.md"] },
    files: { [`${CAPABILITY_DIR}/reviewer.md`]: "not a soul directory\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capability-defined agent is not a directory/);
});

test("validator ACCEPTS a skills[] entry that is a file", (t) => {
  const result = runFixture(t, {
    capability: { skills: ["thing.md"] },
    files: { [`${CAPABILITY_DIR}/thing.md`]: "---\nname: thing\ndescription: fixture\n---\n" },
  });
  assert.equal(result.status, 0, `a single-file skill is legal and must not be rejected: ${result.stderr}`);
});

test("validator accepts an agents[] entry that IS a soul directory", (t) => {
  const result = runFixture(t, {
    capability: { agents: ["agents/reviewer"] },
    files: {
      [`${CAPABILITY_DIR}/agents/reviewer/soul.yaml`]: "name: reviewer\n",
      [`${CAPABILITY_DIR}/agents/reviewer/AGENTS.md`]: "# reviewer\n",
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects deployment targeting smuggled into a capability manifest", (t) => {
  for (const key of ["global", "agent-types", "souls"]) {
    const result = runFixture(t, { capability: { [key]: { developers: true } } });
    assert.equal(result.status, 1, `${key} must not be a capability manifest key`);
    assert.match(result.stderr, /deployment targeting belongs to config|unknown property/);
  }
});

// ---------------------------------------------------------------------------
// Template PORTABILITY. A template is copied verbatim into somebody else's
// repository, so anything our deployment owns becomes a leak there.
// ---------------------------------------------------------------------------

/** The shipped template with one extra root setting appended. */
const planted = (value) => `${SHIPPED_TEMPLATE}agents-md-injection: ${JSON.stringify(value)}\n`;

for (const [label, value] of [
  ["a machine path under a user home", "/Users/someone/oas/injects/review.md"],
  ["an absolute path under any other root", "/tmp/local-machine/review.md"],
  ["a path embedded in a longer argument string", "launch --config=/Users/someone/private.yaml"],
]) {
  test(`validator rejects a template value that is ${label}`, (t) => {
    const result = runFixture(t, { template: planted(value) });
    assert.equal(result.status, 1, `${label} must not travel to another machine`);
    assert.match(result.stderr, /config template is not portable/);
  });
}

test("validator rejects a credential-shaped setting planted in a template", (t) => {
  const result = runFixture(t, { template: `${SHIPPED_TEMPLATE}api_key: sk-live-leaked\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-shaped setting/);
});

test("validator rejects a credential ASSIGNED inside a template value", (t) => {
  // Checking key names alone misses a secret smuggled into an argument string.
  const result = runFixture(t, { template: planted("launch --api-key=sk-live-leaked") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-shaped value/);
});

test("validator rejects a machine path leaked in a template COMMENT", (t) => {
  // The kernel ignores comments entirely; the adopter's repository does not.
  const result = runFixture(t, { template: `# see /Users/someone/notes.md\n${SHIPPED_TEMPLATE}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /user home directory/);
});

test("validator rejects a credential assigned in a template comment", (t) => {
  const result = runFixture(t, { template: `# api_key: sk-live-leaked\n${SHIPPED_TEMPLATE}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-shaped value/);
});

// The accept side. A rule broad enough to catch every path spelling must not
// start rejecting what a good template legitimately carries — otherwise the
// only way to pass the gate is to ship a template that documents nothing.
for (const [label, value] of [
  ["a scope-relative path", ".agents/injections/oas-defaults/oas.md"],
  ["a bare relative path", "injects/framework-workspace.md"],
  ["an https URL", "https://oas.dev/docs/config"],
  ["an https URL whose PATH spells a local-looking root", "https://docs.example.test/home/getting-started"],
  ["an scp-style git remote", "git@github.com:OAS-Framework/oas-dev.git"],
  ["the literal none", "none"],
]) {
  test(`validator accepts a template value that is ${label}`, (t) => {
    const result = runFixture(t, { template: planted(value) });
    assert.equal(result.status, 0, `${label} is portable: ${result.stderr}`);
  });
}

for (const [label, comment] of [
  ["an illustrative placeholder path", "# adopt this into /path/to/your/workspace"],
  ["the portability promise itself", "# no credential, account, or machine path may ship here"],
  ["prose containing the word file:", "# edit this file: before use"],
]) {
  test(`validator accepts ${label} in a template comment`, (t) => {
    const result = runFixture(t, { template: `${comment}\n${SHIPPED_TEMPLATE}` });
    assert.equal(result.status, 0, `${label} is documentation, not a leak: ${result.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// Templates must be readable the way the KERNEL reads them.
// ---------------------------------------------------------------------------

test("validator rejects a template list written as a block sequence", (t) => {
  // The OAS config reader drops those lines, so the adopter would get an EMPTY
  // map from a template that looked populated in review.
  const result = runFixture(t, { template: `${SHIPPED_TEMPLATE}extra:\n  - developer\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /block sequences are dropped/);
});

test("validator rejects a template smuggling config behind __proto__", (t) => {
  // An own-property walk sees nothing; the kernel reads the settings off the
  // prototype chain and applies them.
  const result = runFixture(t, {
    template: "__proto__:\n  capabilities:\n    layers:\n      messaging: none\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a usable config key/);
});

test("validator rejects a manifest carrying a __proto__ key", (t) => {
  const result = runFixture(t, { packageExtras: { ["__proto__"]: { package: "oas.evil" } } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the "__proto__" key is refused/);
});

test("validator rejects a template line the config reader would silently skip", (t) => {
  const result = runFixture(t, { template: `${SHIPPED_TEMPLATE}just some prose\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config template uses YAML the OAS config reader does not support/);
});

test("validator rejects a template descriptor pointing at nothing", (t) => {
  const result = runFixture(t, { template: null });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config template does not exist/);
});
