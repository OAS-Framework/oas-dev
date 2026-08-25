#!/usr/bin/env node
/**
 * oas.dev manifest gate for the RELEASED OAS 0.20 capability-materialization
 * contract.
 *
 * Repo root holds dev tooling (scripts/, schemas/, test/); the DISTRIBUTED
 * package payload lives in the `oas-package/` subtree. Manifests and their
 * resources are validated against the PAYLOAD root, never the repo root:
 * repo-only tooling is not installed bytes and must never be reachable from a
 * package resource path.
 *
 * The rules enforced here mirror the released @oas-framework/oas@0.20.0 engine
 * (lib/core.mjs: loadPackageManifest, isCanonicalTemplatePath,
 * assertCapabilitySelfContained), plus this repository's own stricter
 * conventions. They exist so a contract break is caught in our gate rather than
 * at an adopter's `oas install`.
 *
 * WHAT IS KERNEL LAW vs. REPO CONVENTION — stated because conflating them
 * misleads the next maintainer:
 *
 *   KERNEL      canonical `configTemplates` spelling; template paths under
 *               config-templates/; `configTemplates` and the deprecated
 *               `configs` may not coexist; a dedicated capability root (never
 *               ".") once configTemplates ships; a template path that lstats as
 *               a FILE (a symlink is refused, target notwithstanding);
 *               per-capability self-containment after symlink resolution;
 *               dependencies are package SOURCE SPECS, not capability ids.
 *   CONVENTION  oas.dev 2.0.0 in lockstep with oas.review 2.0.0 (the kernel does
 *               NOT require package version == capability version); the exact
 *               three pinned dependencies; the >=0.20.0 floor on both manifests.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractComments, parseKernelYaml } from "./lib/kernel-yaml.mjs";
import { commentLeaks, valueLeaks } from "./lib/config-portability.mjs";
import { checkSchema } from "./lib/json-schema.mjs";
import { PUBLISHED_SELECTORS } from "./catalog-selectors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repoRoot, "oas-package");

// ------------------------------------------------------------ the pinned shape
// This repository publishes exactly one package, exporting exactly one
// capability. Both are pinned here so a version bump is a deliberate edit to the
// gate rather than a silent drift in a manifest.
const PACKAGE_ID = "oas.dev";
const PACKAGE_VERSION = "2.0.0";
const CAPABILITY_ID = "oas.review";
const CAPABILITY_VERSION = "2.0.0";
const OAS_FLOOR = ">=0.20.0";

/**
 * The EXACT dependency set, imported from scripts/catalog-selectors.mjs so this
 * gate and the CI selector check cannot disagree about what this release pins.
 * Entries are package SOURCE SPECS in official catalog form
 * `<package id>@<selector>`, where the selector overrides the catalog's own ref
 * — so a v-tag pins the acquired source immutably.
 *
 * oas.jira and oas.linear are deliberately absent and actively refused: a task
 * layer is the ADOPTER's choice, and depending on one would drag a provider
 * into every oas.dev closure.
 */
const REQUIRED_DEPENDENCIES = [...PUBLISHED_SELECTORS];
const ADOPTER_SELECTED = /(^|[^a-z0-9])oas[._-](jira|linear)([^a-z0-9]|$)/i;

/** Template names are map keys in the manifest; the kernel's grammar for them. */
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const errors = [];
const report = (path, message) => errors.push(`${path}: ${message}`);
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { report(relative(root, path), `invalid JSON (${error.message})`); return undefined; }
};

/**
 * `__proto__` is not an ordinary key. In an object literal or a JSON document it
 * is an own data property, but every `obj[key] = value` dispatch that copies it
 * walks into the PROTOTYPE instead — so a manifest carrying one is a value this
 * gate can see and a downstream consumer cannot, or vice versa. A manifest never
 * legitimately needs the key, so it is refused wherever one appears.
 */
function refuseProtoKeys(value, at) {
  if (Array.isArray(value)) { value.forEach((item, index) => refuseProtoKeys(item, `${at}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__") { report(`${at}.__proto__`, 'the "__proto__" key is refused: it is invisible to consumers that read through prototype-aware assignment, so what this gate validates would not be what they apply'); continue; }
    refuseProtoKeys(value[key], `${at}.${key}`);
  }
}

/** The shared evaluator (scripts/lib/json-schema.mjs), wired to this gate's
 * error list. Shared with the consumer probe, which validates a real generated
 * lock against the vendored lock schema. */
const validateSchema = (value, schema, at) => checkSchema(value, schema, at, schema, report);

/**
 * A declared LIST resource, or a diagnostic if the manifest did not declare a
 * list at all.
 *
 * `manifest.skills` and `manifest.agents` are arrays by schema, but a schema
 * error is REPORTED, not thrown — so the code after it kept walking, and
 * `"skills": "skills/demo"` (a string, the single-entry spelling a person
 * reaches for) reached `.entries()` and crashed the gate with a TypeError. A
 * crash is the worst possible outcome here: it names no path, produces no
 * "Manifest validation failed" report, and reads as a broken tool rather than
 * as a bad manifest. Every non-array is now degraded to an empty iteration, and
 * the schema violation stands on its own as the diagnostic.
 */
function declaredList(value, at, kind) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report(at, `${kind} must be an array of package-relative paths, got ${value === null ? "null" : typeof value} — a single entry is still written as a one-element array`);
    return [];
  }
  return value;
}

/** The same treatment for a declared MAP (`commands`, `hooks`). `Object.entries`
 * does not crash on a string, which is worse: it silently iterates CHARACTERS
 * and validates entrypoints named "0", "1", "2". */
function declaredMap(value, at, kind) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    report(at, `${kind} must be a map of name → entrypoint, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
    return {};
  }
  return value;
}

/**
 * A declared resource path, resolved and bounded.
 * @param boundary the root the resolved path may not escape: the PAYLOAD root
 *   for package-level declarations, the CAPABILITY root for anything a
 *   capability manifest declares.
 */
function safeResource(base, candidate, at, kind = "path", boundary = root) {
  if (typeof candidate !== "string" || !candidate.trim()) { report(at, `${kind} must be a non-empty string`); return undefined; }
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) { report(at, `${kind} must be package-relative and may not contain '..'`); return undefined; }
  const target = resolve(base, candidate);
  if (!existsSync(target)) { report(at, `${kind} does not exist: ${candidate}`); return undefined; }
  let realTarget;
  try { realTarget = realpathSync(target); }
  catch { report(at, `${kind} is a broken symlink: ${candidate}`); return undefined; }
  const realBoundary = realpathSync(boundary);
  if (realTarget !== realBoundary && !realTarget.startsWith(realBoundary + sep)) {
    report(at, `${kind} escapes ${boundary === root ? "the package payload root" : "its capability root"} after symlink resolution`);
    return undefined;
  }
  return realTarget;
}

/**
 * Contract §2.5 (assertCapabilitySelfContained): a declared directory resource
 * must not merely RESOLVE inside its boundary — nothing UNDER it may escape
 * either, or the materialized artifact is not independently hashable. Broken
 * links count: materialization copies a dangling target into the adopter's
 * deployment, where the failure surfaces as a missing skill, not as a bad
 * package.
 */
function assertContainedTree(dir, at, kind, boundary, visited = new Set()) {
  const realBoundary = realpathSync(boundary);
  let realDir;
  try { realDir = realpathSync(dir); } catch { report(at, `${kind} contains a broken symlink`); return; }
  if (visited.has(realDir)) return;   // symlink cycles terminate here
  visited.add(realDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    let real;
    try { real = realpathSync(path); }
    catch { report(at, `${kind} contains a broken symlink: ${relative(boundary, path)}`); continue; }
    if (real !== realBoundary && !real.startsWith(realBoundary + sep)) {
      report(at, `${kind} contains a path escaping ${boundary === root ? "the package payload root" : "its capability root"}: ${relative(boundary, path)}`);
      continue;
    }
    if (entry.isSymbolicLink()) { if (lstatSync(real).isDirectory()) assertContainedTree(real, at, kind, boundary, visited); }
    else if (entry.isDirectory()) assertContainedTree(path, at, kind, boundary, visited);
  }
}

/** Mirrors isCanonicalTemplatePath in the released kernel. */
const CANONICAL_TEMPLATE_ROOT = "config-templates/";
function isCanonicalTemplatePath(p) {
  if (typeof p !== "string" || !p.startsWith(CANONICAL_TEMPLATE_ROOT)) return false;
  const rest = p.slice(CANONICAL_TEMPLATE_ROOT.length);
  if (!rest || rest.includes("\\")) return false;
  return !rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

// ---------------------------------------------------------------- schemas
/**
 * THE VENDORED SCHEMAS ARE LOADED FAIL-CLOSED.
 *
 * Each one is a byte-identical copy of the published kernel's `docs/` (see
 * SCHEMA-STATUS.md), and every schema-driven check below was previously written
 * as `if (schema) validateSchema(...)` — so deleting `schemas/oas-config.schema.json`
 * silently switched template validation OFF and the gate still printed
 * "Validated …" and exited 0. A gate that reports success when its own rules
 * went missing is worse than no gate: it converts a deletion into a green run.
 *
 * All four are therefore REQUIRED to exist and to parse, named individually so
 * the diagnostic says which one. `oas-lock.schema.json` is not read by this
 * script — the consumer probe validates a real generated lock against it — but
 * it is required here too, because "the four vendored schemas are present and
 * loadable" is a property of the repository, and the offline gate is the only
 * thing that checks it on every push.
 */
const SCHEMA_FILES = {
  package: "oas-package.schema.json",
  capability: "capability-manifest.schema.json",
  config: "oas-config.schema.json",
  lock: "oas-lock.schema.json",
};

const schemas = {};
for (const [role, name] of Object.entries(SCHEMA_FILES)) {
  const path = join(repoRoot, "schemas", name);
  if (!existsSync(path)) {
    report(`schemas/${name}`, `vendored ${role} schema is MISSING — it gates ${role === "lock" ? "the lock the consumer probe checks" : `every ${role} document this repository ships`}, and a validator that silently skips a missing rule reports success for work it did not do. Restore it from the published @oas-framework/oas kernel's docs/`);
    continue;
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { report(`schemas/${name}`, `vendored ${role} schema is unreadable (${error.message}) — the gate refuses to run with a broken rule set rather than skip it`); continue; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report(`schemas/${name}`, `vendored ${role} schema is not a JSON Schema object`);
    continue;
  }
  schemas[role] = parsed;
}

const packagePath = join(root, "oas-package.json");
const packageManifest = readJson(packagePath);
const packageSchema = schemas.package;
const capabilitySchema = schemas.capability;
const configSchema = schemas.config;

if (packageManifest) refuseProtoKeys(packageManifest, "oas-package.json");
if (packageManifest && packageSchema) validateSchema(packageManifest, packageSchema, "oas-package.json");

// ---------------------------------------------------------------- identity
if (packageManifest && packageManifest.package !== PACKAGE_ID) {
  report("oas-package.json.package", `this repository publishes ${PACKAGE_ID} only (found ${JSON.stringify(packageManifest.package)})`);
}
if (packageManifest && packageManifest.version !== PACKAGE_VERSION) {
  report("oas-package.json.version", `must be ${PACKAGE_VERSION} — the 0.20 capability-materialization release (found ${JSON.stringify(packageManifest.version)})`);
}
if (packageManifest && packageManifest.compatibility?.oas !== OAS_FLOOR) {
  report("oas-package.json.compatibility.oas", `must be ${JSON.stringify(OAS_FLOOR)} — the canonical configTemplates/dedicated-root contract landed in 0.20.0 (found ${JSON.stringify(packageManifest.compatibility?.oas)})`);
}

// ------------------------------------------------------------- dependencies
// Package SOURCE SPECS, not capability ids. Exact set equality, order-insensitive
// (the kernel sorts recorded dependencies by package id in the lock, so ordering
// here carries no meaning and must not be something a reviewer has to check).
if (packageManifest) {
  const declared = packageManifest.dependencies;
  if (!Array.isArray(declared)) {
    report("oas-package.json.dependencies", `must be an array of exactly ${JSON.stringify(REQUIRED_DEPENDENCIES)}`);
  } else {
    declared.forEach((spec, index) => {
      const at = `oas-package.json.dependencies[${index}]`;
      if (typeof spec !== "string") { report(at, "dependency source spec must be a string"); return; }
      if (ADOPTER_SELECTED.test(spec)) {
        report(at, `${JSON.stringify(spec)} names an adopter-selected task provider — oas.jira and oas.linear are never oas.dev dependencies, because the task layer is the adopter's choice`);
        return;
      }
      if (!REQUIRED_DEPENDENCIES.includes(spec)) {
        report(at, `${JSON.stringify(spec)} is not one of this release's pinned catalog selectors ${JSON.stringify(REQUIRED_DEPENDENCIES)} — a dependency must be an immutable pinned source spec, never a floating ref`);
      }
    });
    const seen = new Set(declared.filter((spec) => typeof spec === "string"));
    if (seen.size !== declared.length) report("oas-package.json.dependencies", "must not repeat a dependency source spec");
    const missing = REQUIRED_DEPENDENCIES.filter((spec) => !seen.has(spec));
    const extra = [...seen].filter((spec) => !REQUIRED_DEPENDENCIES.includes(spec));
    if (missing.length || extra.length) {
      report("oas-package.json.dependencies", `must be exactly ${JSON.stringify(REQUIRED_DEPENDENCIES)} (as a set, any order)${missing.length ? `; missing ${JSON.stringify(missing)}` : ""}${extra.length ? `; unexpected ${JSON.stringify(extra)}` : ""}`);
    }
  }
}

// ---------------------------------------------------------------- templates
// `configTemplates` is the canonical 0.20 spelling; `configs` is read-only
// compatibility for immutable 0.19 tags. Carrying both is an invalid manifest,
// and NEW authoring (this package) must emit the canonical spelling only.
const hasCanonical = packageManifest?.configTemplates !== undefined;
const hasLegacy = packageManifest?.configs !== undefined;
if (hasCanonical && hasLegacy) report("oas-package.json", 'declares both "configTemplates" and the deprecated "configs" spelling — the kernel refuses a manifest carrying both; use "configTemplates" only');
if (hasLegacy && !hasCanonical) report("oas-package.json.configs", 'uses the DEPRECATED 0.19 spelling — a package on the 0.20 contract must emit "configTemplates"');

const templateKey = hasCanonical ? "configTemplates" : "configs";
const rawTemplates = (hasCanonical ? packageManifest?.configTemplates : packageManifest?.configs) || {};
const templates = rawTemplates && typeof rawTemplates === "object" && !Array.isArray(rawTemplates) ? rawTemplates : {};
const defaults = Object.entries(templates).filter(([, spec]) => spec?.default === true);
if (defaults.length > 1) report(`oas-package.json.${templateKey}`, "at most one config template may be marked default");

for (const [name, spec] of Object.entries(templates)) {
  const at = `oas-package.json.${templateKey}.${name}`;
  if (!TEMPLATE_NAME.test(name)) report(at, `template name must match ${TEMPLATE_NAME} — it is the identifier an adopter passes to \`oas init --package ... --config <name>\``);
  if (!spec?.path) continue;
  if (hasCanonical && !isCanonicalTemplatePath(spec.path)) {
    report(`${at}.path`, `${JSON.stringify(spec.path)} must live under "${CANONICAL_TEMPLATE_ROOT}" with a contained file path (e.g. "${CANONICAL_TEMPLATE_ROOT}default/oas-config.yaml")`);
    continue;
  }
  const real = safeResource(root, spec.path, `${at}.path`, "config template");
  if (!real) continue;
  // LSTAT, NOT STAT — mirroring loadPackageManifest in the released kernel,
  // which writes `if (!lstatSync(p).isFile())`. A SYMLINK to a real file passes
  // `statSync(realpath).isFile()` and fails `lstatSync(declared).isFile()`, so
  // the previous spelling produced the one outcome a repo gate must never
  // produce: gate PASS, kernel FAIL — a package that ships green from here and
  // is refused as an invalid manifest at the adopter's `oas install`.
  const declared = resolve(root, spec.path);
  if (!lstatSync(declared).isFile()) {
    report(`${at}.path`, `config template is not a file: ${spec.path}${lstatSync(declared).isSymbolicLink() ? " — it is a SYMLINK, and the released kernel lstats this path (a link is refused as an invalid package manifest even when its target is a perfectly good file)" : ""}`);
    continue;
  }
  const source = readFileSync(real, "utf8");
  // Parsed with the KERNEL's own semantics, so what is linted here is what an
  // adopter's deployment will actually see. A construct the kernel would drop
  // (a block sequence, an anchor) is an error, not a warning: authoring must
  // never depend on bytes that get thrown away.
  let parsed;
  try { parsed = parseKernelYaml(source); }
  catch (error) { report(at, `config template uses YAML the OAS config reader does not support: ${error.message}`); continue; }
  // Values AND comments, through the single shared predicate the consumer probe
  // also calls — see scripts/lib/config-portability.mjs.
  for (const leak of commentLeaks(extractComments(source))) report(at, `config template is not portable — ${leak}`);
  for (const leak of valueLeaks(parsed)) report(at, `config template is not portable — ${leak}`);
  if (configSchema) validateSchema(parsed, configSchema, `${spec.path}`);
}

// ------------------------------------------------------------- capabilities
const declaredCapabilities = Array.isArray(packageManifest?.capabilities) ? packageManifest.capabilities : [];
if (declaredCapabilities.length !== 1) {
  report("oas-package.json.capabilities", `oas.dev exports exactly one capability (${CAPABILITY_ID}); found ${declaredCapabilities.length} declared capability root(s)`);
}
// A "." root is READ COMPATIBILITY for already-published packages. Authoring
// never emits it, and the released kernel rejects it outright next to
// `configTemplates`, so a materialized artifact stays self-contained.
if (declaredCapabilities.includes(".")) {
  report("oas-package.json.capabilities", 'the package root "." is not a valid capability root once configTemplates ships — use a dedicated root such as "capabilities/<slug>" so the materialized artifact is self-contained');
}

const capabilities = [];
for (const [index, capabilityDir] of declaredCapabilities.entries()) {
  safeResource(root, capabilityDir, `oas-package.json.capabilities[${index}]`, "capability directory");
  if (typeof capabilityDir !== "string" || isAbsolute(capabilityDir) || capabilityDir.split(/[\\/]+/).includes("..")) continue;
  const manifestPath = join(root, capabilityDir, "oas.json");
  if (!existsSync(manifestPath)) { report(`oas-package.json.capabilities[${index}]`, `${capabilityDir} has no oas.json`); continue; }
  const manifest = readJson(manifestPath);
  if (!manifest) continue;
  capabilities.push(manifest);
  refuseProtoKeys(manifest, `${capabilityDir}/oas.json`);
  if (capabilitySchema) validateSchema(manifest, capabilitySchema, `${capabilityDir}/oas.json`);
  const capabilityRoot = dirname(manifestPath);
  // SELF-CONTAINMENT: every declared resource resolves inside the capability's
  // OWN root, not merely inside the package. A capability reaching package-only
  // paths cannot be materialized and is rejected rather than installed broken.
  //
  // The kernel's asymmetry is preserved deliberately: a SKILL entry may be a
  // single file (skills/foo.md) or a directory; a capability-defined AGENT is a
  // soul directory (soul.yaml + AGENTS.md) and nothing else.
  for (const [resourceIndex, resource] of declaredList(manifest.skills, `${capabilityDir}/oas.json.skills`, "skills").entries()) {
    const at = `${capabilityDir}/oas.json.skills[${resourceIndex}]`;
    const real = safeResource(capabilityRoot, resource, at, "skill path", capabilityRoot);
    if (real && statSync(real).isDirectory()) assertContainedTree(join(capabilityRoot, resource), at, "skill tree", capabilityRoot);
  }
  if (manifest.inject) safeResource(capabilityRoot, manifest.inject, `${capabilityDir}/oas.json.inject`, "injection path", capabilityRoot);
  for (const [agentIndex, agent] of declaredList(manifest.agents, `${capabilityDir}/oas.json.agents`, "agents").entries()) {
    const at = `${capabilityDir}/oas.json.agents[${agentIndex}]`;
    const real = safeResource(capabilityRoot, agent, at, "agent path", capabilityRoot);
    if (real) {
      if (!statSync(real).isDirectory()) report(at, "capability-defined agent is not a directory — an agent entry names a soul directory (soul.yaml + AGENTS.md)");
      else assertContainedTree(join(capabilityRoot, agent), at, "capability-defined agent", capabilityRoot);
    }
  }
  // A hook may be a plain "entrypoint args" string or the object form
  // { command, required } (only the spawn hook may set required). Commands are
  // always strings. Reduce either to the executable entrypoint for containment.
  const entrypoint = (spec) => {
    const command = typeof spec === "string" ? spec : (spec && typeof spec === "object" ? spec.command : undefined);
    return typeof command === "string" ? command.trim().split(/\s+/)[0] : command;
  };
  for (const [name, command] of Object.entries(declaredMap(manifest.commands, `${capabilityDir}/oas.json.commands`, "commands"))) safeResource(capabilityRoot, entrypoint(command), `${capabilityDir}/oas.json.commands.${name}`, "command entrypoint", capabilityRoot);
  for (const [event, hook] of Object.entries(declaredMap(manifest.hooks, `${capabilityDir}/oas.json.hooks`, "hooks"))) safeResource(capabilityRoot, entrypoint(hook), `${capabilityDir}/oas.json.hooks.${event}`, "hook entrypoint", capabilityRoot);
  for (const forbidden of ["global", "agent-types", "souls"]) if (Object.hasOwn(manifest, forbidden)) report(`${capabilityDir}/oas.json.${forbidden}`, "deployment targeting belongs to config, not a capability manifest");
}

// The PAYLOAD root as a whole. Per-capability containment says nothing about
// bytes outside the declared resources — a symlink anywhere under oas-package/
// pointing at the repo's tooling, at an agent worktree, or at a machine path is
// still copied by acquisition, so the whole distributed subtree is walked.
if (existsSync(root)) assertContainedTree(root, "oas-package", "the package payload", root);

// ------------------------------------------------------------- the lockstep
if (capabilities.length === 1 && packageManifest) {
  const capability = capabilities[0];
  if (capability.capability !== CAPABILITY_ID) {
    report("oas-package.json.capabilities[0]", `${PACKAGE_ID} exports capability ${CAPABILITY_ID} (found ${JSON.stringify(capability.capability)})`);
  }
  // REPO CONVENTION, not kernel law: the kernel is content for a package and its
  // capability to version independently. We keep them in lockstep so "oas.dev
  // 2.0.0" names one reviewable artifact.
  if (capability.version !== CAPABILITY_VERSION) {
    report(`${declaredCapabilities[0]}/oas.json.version`, `${CAPABILITY_ID} must be ${CAPABILITY_VERSION} — repo convention keeps the capability in lockstep with package ${PACKAGE_VERSION} (found ${JSON.stringify(capability.version)})`);
  }
  if (capability.compatibility?.oas !== OAS_FLOOR) {
    report(`${declaredCapabilities[0]}/oas.json.compatibility.oas`, `must be ${JSON.stringify(OAS_FLOOR)}, matching the package floor (found ${JSON.stringify(capability.compatibility?.oas)})`);
  }
  if (packageManifest.compatibility?.oas !== capability.compatibility?.oas) {
    report("oas-package.json.compatibility.oas", "must match the exported capability's compatibility floor");
  }
}

if (errors.length) {
  process.stderr.write(`Manifest validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Validated ${relative(process.cwd(), packagePath) || "oas-package.json"}, ${capabilities.length} capability manifest(s), and ${Object.keys(templates).length} config template(s) against the OAS 0.20 package contract.\n`);
