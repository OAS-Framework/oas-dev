import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Structural half of the non-Git consumer acceptance test. It mirrors the
// engine's `oas init --package oas.dev` profile validation (lib/packages.mjs
// validateProfile: supplied = own capabilities ∪ dependency-closure providers,
// plus layer agreement) WITHOUT depending on the kernel, so it runs in the
// standalone repo today. The LIVE end-to-end run (acquire → v2 lock graph →
// snapshot → bare install/reconcile → doctor providers/targets → nested
// override) is scripts/consumer-acceptance.mjs, gated on a published OAS
// >=0.19.0 kernel. See SCHEMA-STATUS.md.

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
const read = (...p) => readFileSync(join(...p), "utf8");
const readJson = (...p) => JSON.parse(read(...p));

function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const ci = line.indexOf(":");
    const key = line.slice(0, ci).trim();
    const val = line.slice(ci + 1).trim();
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === "") { const child = {}; parent[key] = child; stack.push({ indent, obj: child }); }
    else parent[key] = val === "true" ? true : val === "false" ? false : val;
  }
  return root;
}

const pkg = readJson(ROOT, "oas-package.json");
const profile = parseYaml(read(ROOT, "configs", "default", "oas-config.yaml"));

// Resolve the closure the way `oas init --package oas.dev` does: the root's OWN
// exported capabilities plus the capabilities of its dependency closure.
const ownCaps = pkg.capabilities.map((rel) => {
  const cap = readJson(ROOT, rel, "oas.json");
  return { id: cap.capability, layer: cap.layer || null, from: rel };
});
const depCaps = (pkg.dependencies || []).map((dep) => {
  const dir = resolve(ROOT, dep);
  assert.ok(existsSync(join(dir, "oas-package.json")), `dependency ${dep} must be a co-located package root`);
  const dpkg = readJson(dir, "oas-package.json");
  const capRel = dpkg.capabilities[0];
  const cap = readJson(dir, capRel, "oas.json");
  return { id: cap.capability, layer: cap.layer || null, from: dep, package: dpkg.package };
});
const supplied = new Map([...ownCaps, ...depCaps].map((c) => [c.id, c]));

test("closure supplies exactly oas.review (own) + oas.okf/oas.aweb/oas.authoring (deps)", () => {
  assert.deepEqual(ownCaps.map((c) => c.id), ["oas.review"]);
  assert.deepEqual(depCaps.map((c) => c.package).sort(), ["oas.authoring", "oas.aweb", "oas.okf"]);
  assert.deepEqual([...supplied.keys()].sort(), ["oas.authoring", "oas.aweb", "oas.okf", "oas.review"]);
  // Jira/Linear are never in the closure (adopter-selected).
  assert.equal(supplied.has("oas.jira"), false);
  assert.equal(supplied.has("oas.linear"), false);
});

test("every capability the profile references is supplied by the closure (validateProfile parity)", () => {
  const caps = profile.capabilities || {};
  const referenced = [];
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (entry && typeof entry === "object") referenced.push({ id: entry.capability, from: entry.from, slot: layer });
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) referenced.push({ id, from: (entry || {}).from, slot: null });

  for (const { id, from, slot } of referenced) {
    assert.equal(from, "installed", `${id} must resolve from the installed closure, not a host path`);
    assert.ok(supplied.has(id), `${id} is supplied by the closure`);
    // Layer agreement: an exclusive slot must bind a capability whose manifest declares that layer.
    if (slot) assert.equal(supplied.get(id).layer, slot, `layer ${slot} binds ${id} whose manifest layer is ${supplied.get(id).layer}`);
  }
  // tasks stays an explicit none (no capability, adopter adds one later).
  assert.equal(caps.layers.tasks, "none");
});

test("expected providers and targets after adoption", () => {
  const caps = profile.capabilities;
  assert.equal(caps.layers.knowledge.capability, "oas.okf");
  assert.equal(caps.layers.messaging.capability, "oas.aweb");
  assert.equal(caps.layers.tasks, "none");
  const at = (id) => caps.additive[id]["agent-types"];
  assert.equal(at("oas.authoring")["framework-authors"], true);
  assert.equal(at("oas.authoring")["package-maintainers"], true);
  assert.equal(at("oas.authoring")["developers"], undefined);
  assert.equal(at("oas.review")["developers"], true);
  assert.equal(at("oas.review")["package-maintainers"], true);
  assert.equal(at("oas.review")["framework-authors"], undefined);
});

test("nested child repo override is the only closer layer, and only for repo-specific policy", () => {
  const child = parseYaml(read(REPO, "test", "fixtures", "framework-child-oas-config.yaml"));
  // The child carries ONLY the framework-repository injection — no re-declaration
  // of the common team policy that the adopted root profile already provides.
  assert.equal((child["agents-md-injection"] || {}).framework, "injects/framework-workspace.md");
  assert.equal("capabilities" in child, false, "the child must not reconstruct common OAS development policy");
  assert.equal("agent-types" in child, false);
  // And the portable root profile never carries the framework injection.
  assert.equal("agents-md-injection" in profile, false);
});
