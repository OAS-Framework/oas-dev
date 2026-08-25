#!/usr/bin/env node
/**
 * THE PINNED DEPENDENCY SELECTORS of oas.dev, and the assertion that the shipped
 * manifest carries exactly them.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT ISN'T. Before publication the three
 * sibling packages were depended on by LOCAL relative path, and this module was
 * the deterministic local→catalog mapping plus an `--apply` that rewrote the
 * manifest at release time. That world is over: the manifest has shipped in
 * catalog form since v2.0.0 was cut, so the local half was dead code describing
 * a state the repository is no longer in — `--check` fell through to it only
 * when the published form did NOT match, and its "pre-publication local form OK"
 * message could never be printed truthfully again. Dead code that documents an
 * untrue state is worse than no code: the next maintainer believes it.
 *
 * What remains is the part that still earns its place — ONE definition of this
 * release's dependency selectors, imported by scripts/validate-manifests.mjs so
 * the gate and this check cannot disagree, and a CLI so CI can assert it
 * without running the whole gate.
 *
 * A SELECTOR IS A GIT REF, NOT A SEMVER RANGE. `oas.okf@v2.0.0` overrides the
 * catalog entry's own ref with the immutable released tag; `oas.okf@2.0.0`
 * parses and then fails to resolve. And an unpinned `oas.okf` resolves to
 * whatever ref the consumer's catalog holds — v1 on the released 0.20.0
 * kernel's bundled catalog — which is why a bare id may never ship here.
 *
 * Usage (from the repository root):
 *   node scripts/catalog-selectors.mjs --check   # the manifest carries exactly these (default)
 *   node scripts/catalog-selectors.mjs --print   # one selector per line
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The DISTRIBUTED payload root, where oas-package.json lives. */
export const ROOT = resolve(fileURLToPath(new URL("../oas-package", import.meta.url)));

/**
 * THE single definition of this release's immutable tag — for this package and
 * for the official leaves alike.
 *
 * It used to be defined twice, here and in scripts/lib/readme-install-sources.mjs,
 * with the same literal under two different justifications ("this release's
 * immutable leaf tag" and "this release's immutable tag"). That is the shape a
 * constant drifts into: one copy gets bumped, the other does not, and each
 * file's tests keep passing against its own. The README lib imports this one
 * now, and test/oas-dev-profile.test.mjs cross-checks it against the shipped
 * manifest's own version, so the literal cannot outlive the release it names.
 *
 * One constant is right because oas.dev and the official leaves ship in lockstep
 * at the same tag: every PUBLISHED_SELECTORS entry below carries it, and so does
 * every install spelling the README documents.
 */
export const RELEASE_TAG = "v2.0.0";

/**
 * The exact dependency set, in official catalog source-spec form
 * `<package id>@<selector>`.
 *
 * oas.jira and oas.linear are deliberately absent and are refused by name in
 * the validator: a task layer is the ADOPTER's choice, and depending on one
 * would drag a provider into every oas.dev closure. The consumer probe proves
 * that absence is policy rather than a catalog gap by installing oas.jira
 * successfully from the SAME catalog that produced the four-package closure.
 */
export const PUBLISHED_SELECTORS = Object.freeze([
  `oas.okf@${RELEASE_TAG}`,
  `oas.aweb@${RELEASE_TAG}`,
  `oas.authoring@${RELEASE_TAG}`,
]);

/** A selector that pins an immutable release: `<catalog id>@v<major.minor.patch>`. */
const PINNED_SELECTOR = /^[a-z0-9][a-z0-9._-]*@v\d+\.\d+\.\d+$/;

export const readManifest = (root = ROOT) =>
  JSON.parse(readFileSync(join(root, "oas-package.json"), "utf8"));

/**
 * Everything wrong with the manifest's `dependencies`, judged against
 * PUBLISHED_SELECTORS.
 *
 * Order is NOT compared: the kernel records dependencies as sorted package ids
 * in the lock, so ordering here carries no meaning and must not be something a
 * reviewer has to check.
 *
 * @returns {string[]} problems; empty means the manifest is in published form
 */
export function publishedSelectorProblems({ root = ROOT, manifest } = {}) {
  const problems = [];
  const doc = manifest || readManifest(root);
  const deps = doc.dependencies;
  if (!Array.isArray(deps)) {
    return [`oas-package.json has no dependencies array (found ${deps === undefined ? "nothing" : typeof deps})`];
  }
  for (const spec of deps) {
    if (typeof spec !== "string") { problems.push(`dependency ${JSON.stringify(spec)} is not a string source spec`); continue; }
    if (!PINNED_SELECTOR.test(spec)) {
      problems.push(`dependency ${JSON.stringify(spec)} is not an immutable pinned catalog selector <id>@v<x.y.z> — a floating ref, a bare id or a local path resolves differently tomorrow, and a dependency is the SOURCE of bytes in every adopter's closure`);
    }
  }
  const declared = new Set(deps.filter((d) => typeof d === "string"));
  if (declared.size !== deps.length) problems.push("dependencies repeat a source spec");
  const missing = PUBLISHED_SELECTORS.filter((s) => !declared.has(s));
  const unexpected = [...declared].filter((s) => !PUBLISHED_SELECTORS.includes(s));
  if (missing.length || unexpected.length) {
    problems.push(
      `dependencies must be exactly ${JSON.stringify(PUBLISHED_SELECTORS)} (as a set, any order)` +
      `${missing.length ? `; missing ${JSON.stringify(missing)}` : ""}` +
      `${unexpected.length ? `; unexpected ${JSON.stringify(unexpected)}` : ""}`,
    );
  }
  return problems;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "")) {
  const mode = process.argv[2] || "--check";
  try {
    if (mode === "--check") {
      const problems = publishedSelectorProblems();
      if (problems.length) {
        console.error(`catalog-selectors: the shipped manifest is not in published form:\n- ${problems.join("\n- ")}`);
        process.exit(1);
      }
      console.log("published catalog form OK:", JSON.stringify(readManifest().dependencies));
    } else if (mode === "--print") {
      console.log(PUBLISHED_SELECTORS.join("\n"));
    } else {
      console.error(`unknown mode ${mode} (use --check | --print)`);
      process.exit(2);
    }
  } catch (e) {
    console.error("catalog-selectors:", e.message || e);
    process.exit(1);
  }
}
