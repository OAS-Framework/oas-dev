import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLISHED_FORM,
  SELECTOR_MAP,
  applyCatalogForm,
  catalogSelectors,
  checkPublishedForm,
} from "../scripts/catalog-selectors.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
// CANONICAL 0.20 LOCATION. The template's CONTENT is byte-identical to the v1
// profile — only its location moved, from configs/ to config-templates/, which
// is what the released kernel's isCanonicalTemplatePath requires.
const TEMPLATE_PATH = "config-templates/default/oas-config.yaml";
const PROFILE = readFileSync(join(ROOT, ...TEMPLATE_PATH.split("/")), "utf8");
const CHILD = readFileSync(join(REPO, "test", "fixtures", "child-oas-config.yaml"), "utf8");

function indentedBlock(text, heading, indent) {
  const lines = text.split("\n");
  const prefix = " ".repeat(indent);
  const start = lines.findIndex((line) => line === `${prefix}${heading}:`);
  assert.notEqual(start, -1, `missing ${heading} block`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(prefix + "  ")) break;
    body.push(line);
  }
  return body.join("\n");
}

test("distribution and capability identities are versioned in deliberate lockstep", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "oas-package.json"), "utf8"));
  const capability = JSON.parse(readFileSync(join(ROOT, "capabilities", "oas-review", "oas.json"), "utf8"));
  assert.equal(pkg.package, "oas.dev");
  assert.equal(pkg.version, "2.0.0");
  assert.deepEqual(pkg.capabilities, ["capabilities/oas-review"]);
  assert.equal(capability.capability, "oas.review");
  // The KERNEL does not require package version == capability version; this
  // repository keeps them equal so "oas.dev 2.0.0" names one reviewable artifact.
  assert.equal(capability.version, "2.0.0");
  // Both floors sit at the release that introduced capability materialization.
  assert.equal(pkg.compatibility.oas, ">=0.20.0");
  assert.equal(capability.compatibility.oas, ">=0.20.0");
  assert.deepEqual(pkg.dependencies, ["oas.okf@v2.0.0", "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"]);
  // No literal placeholder ever ships in the manifest.
  assert.doesNotMatch(JSON.stringify(pkg.dependencies), /TODO|pin-at-publication|placeholder/i);
});

test("the package ships exactly one canonical, default config TEMPLATE", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "oas-package.json"), "utf8"));
  // The deprecated 0.19 spelling may not be emitted, and may not coexist with
  // the canonical one — the released kernel refuses a manifest carrying both.
  assert.equal(pkg.configs, undefined);
  assert.deepEqual(Object.keys(pkg.configTemplates), ["default"]);
  assert.equal(pkg.configTemplates.default.path, TEMPLATE_PATH);
  assert.match(pkg.configTemplates.default.path, /^config-templates\/(?!\.\.?(\/|$))[^/\\][^\\]*$/);
  assert.equal(pkg.configTemplates.default.default, true, "the only template is the default one, so --config is never needed");
  // A dedicated capability root: "." cannot be materialized as a self-contained
  // artifact and is rejected outright by the kernel next to configTemplates.
  assert.ok(!pkg.capabilities.includes("."));
});

test("dependencies use the immutable published catalog-selector form", () => {
  const { deps, selectors } = checkPublishedForm();
  assert.deepEqual(deps, PUBLISHED_FORM);
  assert.deepEqual(deps, ["oas.okf@v2.0.0", "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"]);
  assert.deepEqual(selectors, deps);
});

test("catalog-selector replacement is deterministic (not a TODO)", () => {
  // The publication swap is fully specified by scripts/catalog-selectors.mjs:
  // each local path -> catalog id, version read from the sibling release.
  const selectors = catalogSelectors({ verifySibling: false });
  const byId = Object.fromEntries(selectors.map((s) => [s.split("@")[0], s.split("@")[1]]));
  assert.deepEqual(Object.keys(byId).sort(), ["oas.authoring", "oas.aweb", "oas.okf"]);
  for (const s of selectors) assert.match(s, /^oas\.[a-z]+@v\d+\.\d+\.\d+$/);
  // Jira/Linear are adopter-selected, never oas.dev dependencies.
  assert.deepEqual(SELECTOR_MAP.map((e) => e.catalog).sort(), ["oas.authoring", "oas.aweb", "oas.okf"]);
  // Applying the gate (dry run) yields exactly those catalog selectors and drops
  // the local form; identity/version/profile are untouched.
  const { selectors: applied, text } = applyCatalogForm({ write: false });
  assert.deepEqual(applied, selectors);
  const rewritten = JSON.parse(text);
  assert.deepEqual(rewritten.dependencies, selectors);
  assert.equal(rewritten.package, "oas.dev");
  assert.equal(rewritten.version, "2.0.0");
  // The swap touches dependencies only: the template descriptor is untouched.
  assert.equal(rewritten.configTemplates.default.path, TEMPLATE_PATH);
});

test("default profile is generic OAS development policy", () => {
  assert.match(PROFILE, /^name: oas-framework$/m);
  assert.match(PROFILE, /^team:\n  name: oas-framework$/m);
  assert.doesNotMatch(PROFILE, /\bteam\.id\b|^\s+id:|TODO|\/Users\/|credentials?|secrets?|souls?:/mi);
  for (const type of ["framework-authors", "developers", "package-maintainers"]) {
    assert.match(PROFILE, new RegExp(`^  ${type}:$`, "m"));
  }
  assert.match(PROFILE, /Experts that own an official OAS package's vision, implementation, maintenance, releases, and support/);
  assert.match(indentedBlock(PROFILE, "knowledge", 4), /capability: oas\.okf\n      from: installed/);
  assert.match(indentedBlock(PROFILE, "messaging", 4), /capability: oas\.aweb\n      from: installed/);
  assert.match(PROFILE, /^    tasks: none$/m);
});

test("profile targets authoring and review to the required agent families", () => {
  const authoring = indentedBlock(PROFILE, "oas.authoring", 4);
  const review = indentedBlock(PROFILE, "oas.review", 4);
  assert.match(authoring, /framework-authors: true/);
  assert.match(authoring, /package-maintainers: true/);
  assert.doesNotMatch(authoring, /developers: true/);
  assert.match(review, /developers: true/);
  assert.match(review, /package-maintainers: true/);
  assert.doesNotMatch(review, /framework-authors: true/);
});

test("child repository fixture can override every inherited provider", () => {
  assert.match(CHILD, /^    knowledge: none$/m);
  assert.match(CHILD, /^    messaging: none$/m);
  const authoring = indentedBlock(CHILD, "oas.authoring", 4);
  const review = indentedBlock(CHILD, "oas.review", 4);
  assert.match(authoring, /framework-authors: false/);
  assert.match(authoring, /package-maintainers: false/);
  assert.match(review, /developers: false/);
  assert.match(review, /package-maintainers: false/);
});
