import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The README makes claims about things this repository can CHECK — the closure's
 * executable surface, how the package catalog is overridden, which versions
 * moved in this release. Those are the claims that go stale silently, because
 * nothing about a paragraph fails when the world underneath it changes.
 *
 * So each one is pinned here against the artifact it describes:
 *
 *   trust posture      → oas.review's own manifest for the exemption, and a
 *                        NAMED expectation for the two executable dependencies
 *   catalog override   → this package's own dependency selectors, read from the
 *                        manifest, plus the kernel's REPLACE (not merge)
 *                        semantics
 *   what changed       → the manifests in this repository
 *
 * WHAT THIS SUITE CANNOT DO, stated so nobody reads it as more than it is: it
 * runs offline, so it cannot look inside the released oas.okf / oas.aweb
 * artifacts. The list of executable dependencies below is therefore an
 * EXPECTATION, not a measurement. The measurement is the consumer probe, which
 * reads each capability's executable surface out of the `oas trust` result it
 * just received and requires the README to document `oas trust <id>` for every
 * one the run actually had to approve. Offline: the claim is present and
 * specific. Online: the claim is true.
 *
 * The install-spelling half of the README lives in
 * test/readme-install-sources.test.mjs; this suite deliberately does not repeat
 * it.
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const README = readFileSync(join(REPO, "README.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(REPO, "oas-package", "oas-package.json"), "utf8"));
const CAPABILITY = JSON.parse(readFileSync(
  join(REPO, "oas-package", "capabilities", "oas-review", "oas.json"), "utf8"));

/** The section a heading owns, up to the next `#`/`##`. */
function section(heading) {
  const lines = README.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `README has no ${JSON.stringify(heading)} section`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2} /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

const TRUST = "## Acquire or activate review independently";
const SPELLINGS = "## Install spellings the released kernel accepts";
const CHANGED = "## What changed in 2.0.0";

/**
 * The EXECUTABLE dependencies of this package's closure.
 *
 * `oas.okf@v2.0.0` exports a capability with the `okf` command namespace, a
 * `harvest` command and `soul-scaffold` + `spawn` hooks; `oas.aweb@v2.0.0`
 * exports one with commands and REQUIRED spawn/retire hooks. Neither manifest is
 * readable from here — see the header — so this list is the expectation the
 * consumer probe verifies against the live artifacts in check 7 ("the executable
 * dependencies ARE gated"), which trusts each one and asserts the approval binds
 * to that capability's own artifact integrity.
 */
const EXECUTABLE_DEPENDENCIES = ["oas.okf", "oas.aweb"];

test("the trust posture enumerates BOTH executable dependencies, each needing its own trust", () => {
  const trust = section(TRUST);
  for (const id of EXECUTABLE_DEPENDENCIES) {
    assert.ok(trust.includes(id), `the trust posture never mentions ${id}`);
    assert.ok(new RegExp(`oas trust ${id.replace(".", "\\.")}`).test(trust),
      `the trust posture does not tell the reader to run \`oas trust ${id}\` — ` +
      "each executable capability is approved on its own, and neither approval implies the other");
  }
  // The dependency that carries a command namespace and a harvest command is the
  // one a reader is most likely to assume is covered by installing the package.
  assert.match(trust, /\bokf\b/, "the okf command namespace is part of the surface being trusted");
  assert.match(trust, /\bharvest\b/, "the harvest command is part of oas.okf's executable surface");
  assert.match(trust, /soul-scaffold/, "oas.okf's soul-scaffold hook is part of the surface");
  assert.match(trust, /\bspawn\b/, "the spawn hooks are part of the surface");
  // Each approval binds to its OWN artifact, not to the package or the closure.
  assert.match(trust, /artifact integrity/,
    "the trust posture must say what an approval binds to");
});

test("the trust posture no longer claims the workspace has nothing to trust", () => {
  // The defect this suite was written for: a paragraph titled "there is nothing
  // to trust" that was true of oas.review alone and false of the workspace the
  // template builds. It is a claim about the CLOSURE, so it has to name the
  // closure's executable members.
  const trust = section(TRUST);
  assert.doesNotMatch(trust, /Trust posture: there is nothing to trust/,
    "the closure has two executable capabilities; only oas.review has nothing to trust");
});

test("the trust posture is truthful about oas.review having no executable surface", () => {
  // The other direction: the exemption must stay accurate to the manifest, or a
  // later capability that DID declare a command would be documented as inert.
  assert.equal(CAPABILITY.commands, undefined, "oas.review declares no commands");
  assert.equal(CAPABILITY.hooks, undefined, "oas.review declares no hooks");
  const trust = section(TRUST);
  assert.match(trust, /oas\.review/);
  assert.match(trust, /no executable surface|nothing to trust/i);
});

test("the OKF harvest step is documented as depending on trusting oas.okf", () => {
  // `oas okf harvest` is the knowledge protocol's own last step, and it is part
  // of oas.okf's executable surface: without the approval it cannot run, and
  // notes never reach the soul. That consequence is the reason the enumeration
  // matters, so it is pinned rather than left to the reader to infer.
  const trust = section(TRUST);
  assert.match(trust, /oas okf harvest/, "the harvest command is not shown");
  assert.match(trust, /until `oas trust oas\.okf` is given/i,
    "the README must state that the harvest step cannot run before oas.okf is trusted");
});

test("the catalog paragraph states REPLACE semantics and names the dependency entries", () => {
  const spellings = section(SPELLINGS);
  assert.match(spellings, /OAS_PACKAGE_CATALOG/);
  assert.match(spellings, /REPLACES?\b/,
    "an OAS_PACKAGE_CATALOG override replaces the bundled catalog; it does not merge with it");
  assert.match(spellings, /no merge|there is no merge/i);

  // A MISSING file reads as empty; an unreadable one does NOT.
  //
  // The released kernel's readCatalogFile returns the empty catalog only on
  // `!existsSync(file)`. Everything after that — an EACCES from readFileSync, a
  // JSON syntax error, a non-object root — is raised as
  // `invalid-source: broken package catalog <file>: <reason>` and is never
  // caught, so the command dies. The README used to lump the two together as
  // "a missing or unreadable file reads as an empty catalog", which told a
  // reader with a corrupt catalog to go looking for a resolution failure that
  // will never happen.
  assert.match(spellings, /missing\b[^.]*\bempty/i,
    "the README must say that a MISSING override file reads as an empty catalog");
  assert.doesNotMatch(spellings, /missing or unreadable|unreadable file reads as/i,
    "an unreadable-but-present catalog does NOT read as empty — the kernel throws invalid-source");
  assert.match(spellings, /invalid-source/,
    "the README must name the error code an existing-but-unparseable catalog produces");
  assert.match(spellings, /broken package catalog/,
    "…and the kernel's own message, so a reader can match it against their terminal");
  assert.match(spellings, /cannot be read or parsed|unparseable|corrupt/i,
    "the README must say WHICH condition raises it, not just that some do");
  // The closure consequence: the three dependencies are catalog selectors, so an
  // overriding catalog must carry them too. The Git spellings pin the ROOT
  // package's source and cannot supply a dependency.
  for (const dep of PACKAGE.dependencies) {
    const id = dep.split("@")[0];
    assert.ok(spellings.includes(id), `the catalog paragraph never mentions the dependency ${id}`);
  }
  assert.match(spellings, /cannot rescue/i,
    "the README must retract the claim that the Git spellings are the way in when the catalog is empty");
  assert.doesNotMatch(spellings, /the Git spellings above are the way in/,
    "that claim is false for the v2 closure: a Git source names the root package, not its dependencies");
});

test("the changed-in-2.0.0 table records the oas.review capability version jump", () => {
  const changed = section(CHANGED);
  assert.match(changed, /oas\.review@1\.2\.0/, "the previous exported capability version is not shown");
  assert.match(changed, /oas\.review@2\.0\.0/, "the new exported capability version is not shown");
  assert.equal(CAPABILITY.version, "2.0.0", "and the manifest must actually be at the documented version");
});

test("the intro presents lockstep as adopted AT 2.0.0, not as history", () => {
  const intro = README.split(CHANGED)[0];
  assert.match(intro, /this release is where the two adopt\s+lockstep\s+versioning/i,
    "lockstep starts in 2.0.0 — 1.0.0 shipped oas.review 1.2.0, so 'moves in lockstep' read as a standing fact was false");
  assert.equal(PACKAGE.version, CAPABILITY.version, "and from 2.0.0 on the two versions really are equal");
});
