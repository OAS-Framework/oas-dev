import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

// PARITY IS ABOUT CONTENT, AND THE CONTENT DID NOT CHANGE. The 0.20 restructure
// moved the template from configs/ to the canonical config-templates/ root and
// changed nothing inside it — byte for byte the same profile — so every
// equivalence this suite asserts against the legacy framework config still holds.
const TEMPLATE = ["config-templates", "default", "oas-config.yaml"];
const legacy = parseYaml(readRepo("test", "fixtures", "legacy-framework-oas-config.yaml"));
const profile = parseYaml(read(...TEMPLATE));
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

test("the child oas/ config names the REPO SCOPE and inherits team identity untouched", () => {
  // The fixture's `name` matches the oas-config.yaml the framework repository
  // actually commits (`oas-framework-repo`), not the root profile's
  // `oas-framework`. That difference is deliberate and is the whole content of
  // the delta: `name` is the SCOPE's name, and a distinct one makes `oas doctor`
  // inside oas/ report which scope it resolved.
  assert.equal(child.name, "oas-framework-repo", "the fixture must mirror the framework repo's own config");
  assert.notEqual(child.name, profile.name, "the scope name is what differs");
  // IDENTITY is the team block, and the child does not declare one — so the
  // adopted resolution inside oas/ carries the root profile's team through
  // unchanged. A fixture that renamed the TEAM would be a policy change wearing
  // a scope-name costume, and this is what would catch it.
  assert.equal("team" in child, false, "the child must not redeclare team identity");
  assert.equal(adopted.team.name, "oas-framework", "team identity inside oas/ is the root profile's, unchanged");
  assert.equal(adopted.team.name, legacy.team.name, "…and therefore still the legacy team");
  assert.equal("id" in adopted.team, false, "no resolved team id reaches the package");
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
  assert.deepEqual(pkg.dependencies, ["oas.okf@v2.0.0", "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"]);
  // The profile resolves providers `from: installed` — i.e. from the workspace's
  // installed released closure, not framework-bundled capabilities.
  assert.match(read(...TEMPLATE), /from: installed/);
});

/**
 * WHAT THE PINNED SHA ACTUALLY PINS, stated exactly.
 *
 * On its own, a literal digest in a test says only "these bytes have not
 * changed since somebody wrote this literal down". That is a real and useful
 * property — it is what stops a profile EDIT from hiding inside the 0.20
 * restructure — but it is not the claim PARITY.md makes. PARITY.md claims the
 * v2 template is the V1 FILE, byte for byte.
 *
 * So the claim is derived rather than asserted, wherever git can supply the old
 * bytes: the v1 file is read back out of history and hashed here, at test time.
 * The literal stays as the OFFLINE ANCHOR, for a checkout that has neither the
 * tag nor the base commit — a test that quietly checked nothing there would be
 * the worse outcome.
 *
 * WHERE THE DERIVATION ACTUALLY RUNS. It used to run nowhere that mattered: CI
 * checked out shallow, so the fallback fired on every run and the pipeline only
 * ever proved that a constant matched itself. The validate job now checks out
 * with full history and tags, and sets OAS_REQUIRE_PARITY_DERIVATION so the
 * fallback is a FAILURE there rather than a diagnostic. A local run without the
 * history still degrades gracefully; a CI run that lost it does not.
 */
const V1_TEMPLATE_PATH = "oas-package/configs/default/oas-config.yaml";
const V1_REFS = [
  ["the published v1.0.0 tag", "v1.0.0"],
  ["the release branch's base commit", "dce83b6"],
];
const PINNED_V1_SHA = "daf943e7b9bd1a3b9118c4a85cb39fdde1e37ac220ae2f8aabcfe12bc06a3655";

/** The v1 template's bytes at `ref`, or undefined when history is unavailable
 * (shallow clone, no tags, no git). */
function v1TemplateAt(ref) {
  const run = spawnSync("git", ["-C", REPO, "show", `${ref}:${V1_TEMPLATE_PATH}`], {
    encoding: "buffer", maxBuffer: 4 * 1024 * 1024,
  });
  return run.status === 0 && run.stdout?.length ? run.stdout : undefined;
}

test("parity of the BYTES: only the template's location moved in the 0.20 restructure", (t) => {
  const source = read(...TEMPLATE);
  const shipped = createHash("sha256").update(source).digest("hex");

  // Offline anchor: unchanged since the v2 restructure. This alone is what
  // stops a profile edit from hiding inside a file move.
  assert.equal(shipped, PINNED_V1_SHA,
    "the shipped template's bytes changed — if that is intended, the parity assertions above are the ones that must be re-argued, not this literal");

  // Self-verifying half: the same bytes really are the v1 file's, read out of
  // history rather than taken on trust.
  const derived = V1_REFS.map(([label, ref]) => [label, v1TemplateAt(ref)]).filter(([, bytes]) => bytes);
  if (!derived.length) {
    const unavailable = `git could not supply ${V1_TEMPLATE_PATH} at ${V1_REFS.map(([, r]) => r).join(" or ")} ` +
      "(shallow checkout, no tags, or no git)";
    // In CI the history is fetched on purpose (see the header and
    // .github/workflows/ci.yml), so the fallback firing means the checkout
    // changed — and a pipeline that silently stops deriving is exactly the
    // defect this flag exists to make loud.
    assert.ok(!process.env.OAS_REQUIRE_PARITY_DERIVATION,
      `${unavailable} — but OAS_REQUIRE_PARITY_DERIVATION is set, so the pinned literal may not stand in for it. ` +
      "Restore fetch-depth: 0 (history AND tags) on the validate job's checkout.");
    t.diagnostic(`${unavailable} — the pinned literal above is standing in for the derivation`);
    return;
  }
  for (const [label, bytes] of derived) {
    assert.equal(createHash("sha256").update(bytes).digest("hex"), shipped,
      `the v2 template is not byte-identical to the v1 file at ${label} — the 0.20 restructure moved the profile, it did not change it`);
    assert.equal(bytes.toString("utf8"), source, `and the two differ in content at ${label}`);
  }

  // And the abandoned location is really gone, so nothing can adopt the old copy.
  assert.equal(existsSync(join(ROOT, "configs")), false, "the pre-0.20 configs/ root must not survive");
});
