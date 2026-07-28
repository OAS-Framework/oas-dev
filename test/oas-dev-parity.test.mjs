import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const readRepo = (...p) => readFileSync(join(REPO, ...p), "utf8");

// Minimal indentation-based YAML subset parser — enough for these config files
// (nested maps, `key: value`, `key:` maps, `#` comment lines). No lists, no
// multiline scalars. Keeps the package test dependency-free and portable into
// the standalone oas-dev repository.
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
    if (val === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = val === "true" ? true : val === "false" ? false : val;
    }
  }
  return root;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object"
      ? deepMerge(a[k], v) : v;
  }
  return out;
}

// Effective, resolution-relevant view of a config for one agent family.
function effective(cfg, family) {
  const caps = cfg.capabilities || {};
  const layers = caps.layers || {};
  const additive = caps.additive || {};
  const assigned = (id) => {
    const at = additive[id] && additive[id]["agent-types"];
    return !!(at && at[family] === true);
  };
  return {
    knowledge: layers.knowledge?.capability || "none",
    messaging: layers.messaging?.capability || "none",
    tasks: typeof layers.tasks === "string" ? layers.tasks : (layers.tasks?.capability || "present"),
    authoring: assigned("oas.authoring"),
    review: assigned("oas.review"),
    worktreeMode: !!(cfg["work-modes"] && "worktree" in cfg["work-modes"]),
    frameworkInjection: (cfg["agents-md-injection"] || {}).framework || null,
  };
}

const legacy = parseYaml(readRepo("test", "fixtures", "legacy-framework-oas-config.yaml"));
const profile = parseYaml(read("configs", "default", "oas-config.yaml"));
const child = parseYaml(readRepo("test", "fixtures", "framework-child-oas-config.yaml"));
// New resolution inside oas/: adopted root profile, with the child repo config
// as the closer override.
const adopted = deepMerge(profile, child);

test("parity: existing families resolve equivalently under adopted root + child repo", () => {
  for (const family of ["framework-authors", "developers"]) {
    const was = effective(legacy, family);
    const now = effective(adopted, family);
    // Preserved exactly: knowledge=OKF, tasks=none, authoring→framework-authors,
    // review→developers, worktree mode, and the framework-workspace injection.
    assert.equal(now.knowledge, "oas.okf", `${family} knowledge`);
    assert.equal(now.knowledge, was.knowledge, `${family} knowledge parity`);
    assert.equal(now.tasks, "none", `${family} tasks`);
    assert.equal(now.tasks, was.tasks, `${family} tasks parity`);
    assert.equal(now.authoring, was.authoring, `${family} authoring assignment parity`);
    assert.equal(now.review, was.review, `${family} review assignment parity`);
    assert.equal(now.worktreeMode, true, `${family} worktree mode present`);
    assert.equal(now.worktreeMode, was.worktreeMode, `${family} worktree parity`);
    assert.equal(now.frameworkInjection, "injects/framework-workspace.md", `${family} framework injection`);
    assert.equal(now.frameworkInjection, was.frameworkInjection, `${family} framework injection parity`);
  }
  // Concrete family intent preserved (not just structure).
  assert.equal(effective(legacy, "framework-authors").authoring, true);
  assert.equal(effective(adopted, "framework-authors").authoring, true);
  assert.equal(effective(adopted, "framework-authors").review, false);
  assert.equal(effective(adopted, "developers").review, true);
  assert.equal(effective(adopted, "developers").authoring, false);
});

test("preserved: the established team name oas-framework, with no machine state in the shipped profile", () => {
  // Founder ruling: the non-Git workspace changes the filesystem/config scope,
  // not the team identity. Name and team name are PRESERVED, not renamed.
  assert.equal(profile.name, "oas-framework");
  assert.equal(profile.team.name, "oas-framework");
  assert.equal(profile.name, legacy.name, "team name preserved from the legacy config");
  assert.equal(profile.team.name, legacy.team.name, "team name preserved");
  // Only the deployment-specific team id (and account/host paths) is substituted out.
  assert.equal("id" in profile.team, false, "no resolved team id in the package");
});

test("delta: messaging is explicit aweb in the portable root (legacy inherited it from the outer laptop config)", () => {
  assert.equal(effective(legacy, "developers").messaging, "none", "legacy config declares no messaging (came from the outer config)");
  assert.equal(effective(adopted, "developers").messaging, "oas.aweb", "portable root declares aweb explicitly");
  assert.equal(effective(adopted, "framework-authors").messaging, "oas.aweb");
});

test("delta: package-maintainers family added and assigned to authoring + review", () => {
  assert.equal("package-maintainers" in (legacy["agent-types"] || {}), false, "legacy had no package-maintainers");
  assert.ok(profile["agent-types"]["package-maintainers"], "profile declares package-maintainers");
  assert.equal(effective(adopted, "package-maintainers").authoring, true);
  assert.equal(effective(adopted, "package-maintainers").review, true);
  // Layering guard: a package expert operating in its OWN sibling repo resolves
  // the root profile plus its own (non-framework) child config — it must NOT
  // inherit the framework-workspace injection. Modeled as the root profile
  // alone (no framework child override in a sibling package repo).
  assert.equal(effective(profile, "package-maintainers").frameworkInjection, null,
    "the framework injection must not reach package experts in sibling repos");
  // Inside oas/ itself, the same maintainer DOES get it via the child config.
  assert.equal(effective(adopted, "package-maintainers").frameworkInjection, "injects/framework-workspace.md");
});

test("layering: the framework-workspace injection is closer (child repo), never in the portable root profile", () => {
  // If it were in the root profile it would apply to every sibling package
  // expert and reference a path that cannot resolve in a non-Git root.
  assert.equal("agents-md-injection" in profile, false, "root profile carries no framework-specific injection");
  assert.equal((child["agents-md-injection"] || {}).framework, "injects/framework-workspace.md",
    "the child oas/ repo config carries it");
});

test("delta: released package provenance flows through oas.dev catalog selectors, not framework-bundled copies", () => {
  const pkg = JSON.parse(read("oas-package.json"));
  // Pre-publication local form; catalog-selectors.mjs swaps to released
  // selectors at publication (proven deterministic in oas-dev-profile.test.mjs).
  assert.deepEqual(pkg.dependencies, ["../../oas-okf/oas-package", "../../oas-aweb/oas-package", "../../oas-authoring/oas-package"]);
  // The profile resolves providers `from: installed` — i.e. from the workspace's
  // installed released closure, not framework-bundled capabilities.
  assert.match(read("configs", "default", "oas-config.yaml"), /from: installed/);
});
