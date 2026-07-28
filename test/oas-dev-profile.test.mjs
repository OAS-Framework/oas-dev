import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOCAL_FORM,
  SELECTOR_MAP,
  applyCatalogForm,
  catalogSelectors,
  checkLocalForm,
} from "../scripts/catalog-selectors.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
const PROFILE = readFileSync(join(ROOT, "configs", "default", "oas-config.yaml"), "utf8");
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

test("distribution and capability identities remain independently versioned", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "oas-package.json"), "utf8"));
  const capability = JSON.parse(readFileSync(join(ROOT, "capabilities", "oas-review", "oas.json"), "utf8"));
  assert.equal(pkg.package, "oas.dev");
  assert.equal(pkg.version, "1.0.0");
  assert.deepEqual(pkg.capabilities, ["capabilities/oas-review"]);
  assert.equal(capability.capability, "oas.review");
  assert.equal(capability.version, "1.2.0");
  assert.equal(pkg.configs.default.path, "configs/default/oas-config.yaml");
  assert.equal(pkg.configs.default.default, true);
  assert.deepEqual(pkg.dependencies, ["../../oas-okf/oas-package", "../../oas-aweb/oas-package", "../../oas-authoring/oas-package"]);
  // No literal placeholder ever ships in the manifest.
  assert.doesNotMatch(JSON.stringify(pkg.dependencies), /TODO|pin-at-publication|placeholder/i);
});

test("dependencies use the pre-publication local package-root-relative form", () => {
  // The engine resolves relative-path dependencies between co-located local
  // packages, so a consumer probe against local roots gets a real closure.
  const { deps, selectors } = checkLocalForm();
  assert.deepEqual(deps, LOCAL_FORM);
  assert.deepEqual(deps, ["../../oas-okf/oas-package", "../../oas-aweb/oas-package", "../../oas-authoring/oas-package"]);
  // Gate proves each local path resolves to the mapped release sibling.
  assert.equal(selectors.length, 3);
});

test("catalog-selector replacement is deterministic (not a TODO)", () => {
  // The publication swap is fully specified by scripts/catalog-selectors.mjs:
  // each local path -> catalog id, version read from the sibling release.
  const selectors = catalogSelectors();
  const byId = Object.fromEntries(selectors.map((s) => [s.split("@")[0], s.split("@")[1]]));
  assert.deepEqual(Object.keys(byId).sort(), ["oas.authoring", "oas.aweb", "oas.okf"]);
  for (const s of selectors) assert.match(s, /^oas\.[a-z]+@\d+\.\d+\.\d+$/);
  // Jira/Linear are adopter-selected, never oas.dev dependencies.
  assert.deepEqual(SELECTOR_MAP.map((e) => e.catalog).sort(), ["oas.authoring", "oas.aweb", "oas.okf"]);
  // Applying the gate (dry run) yields exactly those catalog selectors and drops
  // the local form; identity/version/profile are untouched.
  const { selectors: applied, text } = applyCatalogForm({ write: false });
  assert.deepEqual(applied, selectors);
  const rewritten = JSON.parse(text);
  assert.deepEqual(rewritten.dependencies, selectors);
  assert.equal(rewritten.package, "oas.dev");
  assert.equal(rewritten.version, "1.0.0");
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
