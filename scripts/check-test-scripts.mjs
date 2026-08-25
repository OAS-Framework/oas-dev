#!/usr/bin/env node
/**
 * Gate AND runner: `npm test` must run exactly this repository's suites, and
 * all of them. This file both checks that property and performs the run.
 *
 * The property can be violated in ways a check inside the test run cannot see:
 *
 *  - BARE DISCOVERY. `node --test` with no file arguments walks the working
 *    tree and executes every `*.test.mjs` it finds. An OAS repository contains
 *    nested agent worktrees at `agents/<soul>/instances/<id>/work/`, each a full
 *    checkout at whatever revision that instance is on, so bare discovery runs
 *    other instances' stale suites. Green then depends on which worktrees exist
 *    on the machine: it passes in CI (clean checkout) and means something else
 *    locally.
 *  - SELECTION. `--test-name-pattern`, `--test-only` and friends make green mean
 *    "the tests that ran passed" rather than "the suites passed" — and a filter
 *    can exclude the very assertion that would report it.
 *
 * WHY THIS SHAPE, AND NOTHING CLEVERER.
 *
 * Four designs failed before this one, each beaten by a spelling it did not
 * model:
 *
 *   1. classify targets by suite-path shape → `--test-name-pattern
 *      test/a.test.mjs`, where the VALUE has that shape;
 *   2. track which options consume a value  → `--redirect-warnings
 *      test/a.test.mjs`, one omission from an unenumerable set;
 *   3. tokenize the script text             → `\--redirect-warnings`: the SHELL
 *      removes the escape, node sees the real option, the tokenizer sees an
 *      inert word;
 *   4. a strict grammar for the invocation, applied to segments a DETECTOR
 *      found → `node --te${UNSET}st && node --test test/a.test.mjs`: the shell
 *      reassembles `--test` from an expansion, so the first process performs
 *      bare discovery while the detector never sees an invocation to check.
 *
 * Every one of them lost the same way: they tried to UNDERSTAND a command
 * assembled by two systems whose semantics this gate does not own — the shell's
 * quoting, escaping, expansion and substitution, and Node's option grammar.
 * Detection is the weak point, because anything undetected is implicitly
 * allowed.
 *
 * So this gate parses nothing and detects nothing. It builds the scripts block
 * the package MUST have, character for character, and compares. Then it runs
 * the suites ITSELF, spawning node with the inventory as ARGV (`shell: false`),
 * so no shell ever re-reads those paths. Two consequences worth stating:
 *
 *  - A suite path is never shell text. A file named `test/ ; true #.test.mjs`
 *    would otherwise splice `; true #` into the command, dropping the suite and
 *    making the run green. Such a name is now REJECTED, loudly, before any
 *    command is built — the safe grammar below is the whole allowed alphabet.
 *  - An EMPTY inventory is rejected. `node --test` with zero paths IS bare
 *    discovery, so a canonical-looking command built from an empty inventory
 *    would bless the exact defect this gate exists to prevent.
 *
 * The same reasoning governs VALIDATION. `npm run validate && node <this>` puts
 * the validator in a command string, where whatever runs the string decides
 * whether it happens; a `test` that rewrote package.json and called this file
 * directly skipped validation entirely and still exited 0. So this file runs the
 * validator too. A step this gate performs cannot be skipped by re-spelling the
 * command that invokes the gate.
 *
 * WHAT THIS GATE DOES NOT PROMISE — stated precisely, because an overstated
 * guarantee is worse than none.
 *
 * `npm_lifecycle_script` is a CONSISTENCY CHECK, not attestation. npm sets it to
 * the command it loaded, so it catches an on-disk `test` that disagrees with the
 * running one. It does NOT prove what npm loaded: the loaded command controls
 * the environment of everything it spawns, so it can rewrite package.json AND
 * export a canonical-looking value. That bypass is real and reproducible; it is
 * checked here because divergence is worth reporting, not because it is
 * unforgeable.
 *
 * More broadly: a `pretest`, an edit to THIS file, or a hostile `test` executes
 * before or as the gate. No in-repository check survives a committer willing to
 * edit the checker, and moving the check to another file in the same repository
 * relocates that boundary without closing it. The canonical-scripts comparison
 * rejects `pretest`/`posttest` in the tree; review, protected CI and branch
 * policy are the controls beyond it.
 *
 * That boundary includes RUNTIME INJECTION into this process. `NODE_OPTIONS`
 * carries `--require`/`--import`, so whoever launches the gate can load code
 * into it and rewrite what it does — which is editing the checker by another
 * means, not a separate weakness. It is listed here so nobody reads the
 * guarantee below as wider than it is.
 *
 * What this gate DOES guarantee is narrower and load-bearing: when it runs in a
 * process whose own runtime has not been tampered with, validation and exactly
 * the inventoried suites run with it. Its CHILDREN are covered unconditionally,
 * because it builds their environment rather than inheriting one (see
 * `childEnv`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative, POSIX-separated. */
const normalize = (path) => String(path).replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * The entire alphabet a suite path may use. Deliberately far narrower than the
 * filesystem allows: everything outside it — whitespace, quotes, `;`, `&`, `|`,
 * `$`, `#`, backslashes, newlines — is shell-significant somewhere, and this
 * gate does not own the shell's semantics (see header). Anchored, `..` excluded.
 */
const SAFE_SUITE_PATH = /^test(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9._-]+\.test\.mjs$/;
const isSafeSuitePath = (path) =>
  SAFE_SUITE_PATH.test(path) && !path.split("/").includes("..");

/** RECURSIVE inventory of a suite tree, as sorted paths relative to `root`. */
export function inventorySuites(dir, root = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...inventorySuites(path, root));
    else if (entry.name.endsWith(".test.mjs")) out.push(normalize(relative(root, path)));
  }
  return out.sort();
}

// ─────────────────────────────────────────────────── coverage: nothing left out
/**
 * THE INVENTORY IS A DENY-LIST TOO, AND THAT IS THE HOLE THIS CLOSES.
 *
 * `inventorySuites` collects `test/**\/*.test.mjs`. Node's own discovery is much
 * wider, so a file this gate never names can still be a file a developer wrote
 * as a suite and reasonably believes is running:
 *
 *   test/legacy.test.js       wrong EXTENSION — discoverable, never inventoried
 *   lib/parser.test.mjs       right extension, wrong DIRECTORY
 *   test/parser_test.mjs      a naming convention node honours and we do not
 *   lib/test/parser.mjs       a `test` directory node discovers and we do not walk
 *   test/helpers/fixture.mjs  still inside a `test` directory: node RUNS it
 *   test/linked.mjs -> ../x   a symlinked FILE, which node follows and runs
 *   test/suites -> ../extra   a symlinked DIRECTORY, which nobody follows
 *
 * Each one is silent: `npm test` passes, prints a suite count that looks right,
 * and the file never executes. That is worse than a red gate, because it is
 * indistinguishable from green.
 *
 * NODE'S ACTUAL RULE, MEASURED RATHER THAN REMEMBERED. The two prongs below
 * were established empirically against node v22.21.1 by planting files and
 * reading back `node --test --test-reporter=tap`'s subtest names, because an
 * approximation here is a hole by another name:
 *
 *   DIRECTORY  inside a directory named exactly `test`, AT ANY DEPTH, EVERY
 *              script file is a test, whatever its name and however deep below
 *              that directory it sits. `lib/test/parser.mjs`,
 *              `packages/foo/test/bar.mjs`, `a/b/test/c/suite.mjs` and
 *              `test/helpers/fixture.mjs` all ran; `tests/`, `realtest/` and
 *              `Test/` did NOT — the directory name is matched exactly.
 *   NAME       anywhere else, `test`, `test-*` or `*[.\-_]test`, with a script
 *              extension. `test-.mjs`, `-test.mjs` and `_test.mjs` match (the
 *              affix may be empty); `testfoo`, `test_foo`, `test.foo` and
 *              `atest` do not. FILE names match case-INSENSITIVELY here
 *              (`foo.Test.mjs`, `BAR_TEST.mjs` and `TEST-baz.mjs` all ran),
 *              which is the fail-closed spelling in any case: on a
 *              case-sensitive filesystem it flags a file node would skip, and
 *              a loud false report beats a silent unrun suite.
 *   EXTENSION  js, cjs, mjs — and, on node 22's type-stripping runtime, ts,
 *              mts, cts, which were confirmed discoverable under BOTH prongs.
 *              `.jsx`/`.tsx` were confirmed NOT discoverable.
 *   SKIPPED    `node_modules`, and every entry whose name begins with `.` —
 *              both confirmed: `node_modules/pkg/test/n.mjs`, `.hidden/test/h.mjs`
 *              and `.test.mjs` were all left alone by node.
 *
 * SYMLINKS, in the two directions node treats differently:
 *
 *   A symlinked FILE under a test directory IS followed and run by node. It is
 *   invisible to this gate's walk unless the walk stats it, and it is only in
 *   the inventory when its name happens to end `.test.mjs` — so
 *   `test/helper.mjs -> ../elsewhere/suite.mjs` runs under bare discovery and
 *   never under the gate. REFUSED, fail-closed: its bytes live outside the tree
 *   this gate reasons about, so it is not something to silently include either.
 *
 *   A symlinked DIRECTORY is followed by NOBODY: node does not traverse it
 *   (confirmed — `test/suites -> ../elsewhere/suites` yielded nothing) and
 *   readdir-based recursion, including inventorySuites', reports a link rather
 *   than a directory and skips the subtree. So suites beneath it run NOWHERE
 *   while the tree still looks populated to a reader. Also refused.
 *
 * NO HELPER EXEMPTION, and this is the correction that removed one. The gate
 * used to exempt any extension-asymmetric `.mjs` under `test/` as "a helper
 * module node would import but never run". That was simply false: node runs
 * every script file under a `test` directory, at any depth — `test/lib/`,
 * `test/helpers/` and `test/fixtures/` included. The exemption therefore hid an
 * arbitrary suite from the gate while `node --test` executed it, so it is gone.
 * A helper module belongs OUTSIDE every directory named `test` (this repository
 * keeps its shared code in scripts/lib/); there is no location under one that
 * node will leave alone.
 *
 * EXCLUDED FROM THE SCAN, and why each:
 *
 *   node_modules/                  not our source; installed trees legitimately
 *                                  carry thousands of their own test files, and
 *                                  node skips them too
 *   dot-prefixed entries           node skips them, so nothing under one is
 *                                  discoverable in the first place
 *   agents/<soul>/instances/<id>/  ANOTHER INSTANCE'S CHECKOUT — a foreign work
 *                                  tree this repository neither owns nor may
 *                                  rewrite, sitting at whatever revision that
 *                                  instance is on. These are the exact trees
 *                                  this gate exists to keep out of the run (see
 *                                  the header); failing on them would make the
 *                                  gate red on every machine that has a live
 *                                  instance, over files whose fix is not this
 *                                  repository's to make.
 *
 * The list is closed and short on purpose. Anything else discoverable is either
 * inventoried or reported.
 */
/** Extensions node's test runner will load. Verified under both prongs. */
const SCRIPT_EXTENSION = /\.(?:c|m)?[jt]s$/i;
/** Node's name convention, OUTSIDE a `test` directory. Case-insensitive: see above. */
const TEST_FILE_NAME = /^(?:test|test-.*|.*[.\-_]test)\.(?:c|m)?[jt]s$/i;
/** The one directory name node treats as "everything in here is a test". */
const TEST_DIR = "test";

/** Directory names never walked, wherever they appear. Dot-prefixed entries are
 * skipped separately, by the same rule node applies. */
const DISCOVERY_EXCLUDED_DIRS = new Set(["node_modules"]);

/** True for `agents/<soul>/instances/...` — another instance's checkout. */
const isNestedInstance = (segments) =>
  segments[0] === "agents" && segments.length > 2 && segments[2] === "instances";

/** True when `rel` sits inside a directory named `test`, at any depth. */
const underTestDir = (segments) => segments.slice(0, -1).includes(TEST_DIR);

/** Would `node --test`, run bare at the repository root, execute this file? */
function nodeWouldDiscover(rel) {
  const segments = rel.split("/");
  const base = segments[segments.length - 1];
  if (segments.some((segment) => segment.startsWith("."))) return false;
  if (segments.includes("node_modules")) return false;
  if (underTestDir(segments)) return SCRIPT_EXTENSION.test(base);
  return TEST_FILE_NAME.test(base);
}

/** Repository-relative paths of every file, minus the exclusions above.
 * @returns {{files: string[], problems: string[]}} problems are symlinks
 *   refused rather than followed. */
function walkRepository(root) {
  const files = [];
  const problems = [];
  const visit = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }   // unreadable directory: nothing to inventory in it
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const segments = rel.split("/");
      if (DISCOVERY_EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;   // node skips these; so do we
      if (isNestedInstance(segments)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // FAIL CLOSED, both ways, the way the released kernel treats a symlinked
        // package resource. See the header for what node does with each.
        let target;
        try { target = statSync(path); } catch { continue; }   // broken link: nothing to run
        if (target.isDirectory() && segments.includes(TEST_DIR)) {
          problems.push(
            `symlinked directory ${JSON.stringify(rel)} under a test/ tree — NOBODY follows it: \`node --test\` ` +
            "does not traverse a symlinked directory, and the suite inventory is built with readdir, which reports " +
            "a link rather than a directory. Every suite beneath it therefore runs nowhere while the tree still " +
            "looks populated. Refused rather than followed: move the suites into test/ or name them individually.",
          );
        } else if (target.isFile() && nodeWouldDiscover(rel)) {
          problems.push(
            `symlinked test file ${JSON.stringify(rel)} — \`node --test\` FOLLOWS a symlinked file and runs it, but ` +
            "this gate names an inventory built from the tree, so the link's target executes under bare discovery " +
            "and never under the gate. Its bytes also live outside the tree this gate reasons about. Refused: " +
            "move the file into test/ under its own name.",
          );
        }
        continue;
      }
      if (entry.isDirectory()) { visit(path, rel); continue; }
      files.push(rel);
    }
  };
  visit(root, "");
  return { files, problems };
}

/**
 * Files node --test would discover that this gate would never run.
 * @param {string[]} inventory the suite paths the gate is about to name
 * @returns {string[]} problems; empty means the inventory covers everything
 */
export function coverageProblems(inventory, root = ROOT) {
  const named = new Set(inventory.map(normalize));
  const { files, problems } = walkRepository(root);
  for (const rel of files) {
    if (named.has(rel)) continue;
    if (!nodeWouldDiscover(rel)) continue;
    problems.push(
      `${JSON.stringify(rel)} is a file \`node --test\` DISCOVERS but this gate never runs — the inventory is ` +
      `test/**/*.test.mjs, and nothing else reaches the command. A suite that never executes is worse than a ` +
      `failing one, because green looks identical either way. Rename it to test/<name>.test.mjs; if it is NOT a ` +
      `suite, move it out of every directory named "test" (node runs every script file under one) and give it a ` +
      `name node does not treat as a test.`,
    );
  }
  return problems;
}

/**
 * Problems with the inventory ITSELF, checked before any command is built.
 * @returns {string[]} empty means the inventory is safe to name in a command.
 */
export function inventoryProblems(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    return [
      "no suites found under test/ — refusing to build a `node --test` command with no paths, " +
        "because that IS bare discovery: it would walk the tree and execute nested agent worktrees.",
    ];
  }
  return inventory
    .filter((path) => !isSafeSuitePath(path))
    .map(
      (path) =>
        `unsafe suite path ${JSON.stringify(path)} — suite paths must match ${SAFE_SUITE_PATH}. ` +
        "Characters outside that alphabet are shell-significant, and a path spliced into a shell " +
        "command can drop its own suite while leaving the run green. Rename the file.",
    );
}

/**
 * THE package scripts, derived from what is on disk. `test` validates, then
 * hands the run to this file, which names every suite under test/ as argv.
 * @throws if the inventory is not safe to build a command from.
 */
export function canonicalScripts(inventory) {
  const problems = inventoryProblems(inventory);
  if (problems.length) throw new Error(problems.join("\n"));
  return {
    validate: "node scripts/validate-manifests.mjs",
    // No `npm run validate &&` chain: the gate runs the validator itself, so no
    // re-spelling of this command can skip it. See the header.
    test: "node scripts/check-test-scripts.mjs",
    probe: "node scripts/consumer-probe.mjs",
  };
}

/**
 * @param {object} pkg parsed package.json
 * @param {string[]} inventory suite paths under test/
 * @param {NodeJS.ProcessEnv} [env] the environment the gate is running in
 * @returns {string[]} problems; empty means the scripts block is exactly canonical.
 */
export function checkScripts(pkg, inventory, env = {}) {
  const problems = inventoryProblems(inventory);
  if (problems.length) return problems;

  const actual = pkg.scripts || {};
  const expected = canonicalScripts(inventory);

  // Object.hasOwn, never `in`: `"constructor" in {}` is true, so an `in` test
  // would treat an inherited function as a declared script and skip the
  // comparison that is the whole point of this gate.
  for (const [name, command] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, name)) { problems.push(`missing script "${name}": ${command}`); continue; }
    if (actual[name] !== command) {
      problems.push(`script "${name}" is not the canonical command\n    expected: ${command}\n    actual:   ${actual[name]}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!Object.hasOwn(expected, name)) {
      problems.push(`unexpected script "${name}": ${actual[name]} — this gate compares the whole scripts block against a canonical set, because anything it merely failed to RECOGNIZE would be implicitly allowed. Add it to canonicalScripts() deliberately.`);
    }
  }

  // Consistency check, NOT attestation: the loaded command controls this
  // variable in everything it spawns, so a hostile `test` can forge it. It is
  // still worth reporting when the running command disagrees with the file.
  if (env.npm_lifecycle_event === "test" && typeof env.npm_lifecycle_script === "string") {
    if (env.npm_lifecycle_script !== expected.test) {
      problems.push(
        `npm is running a "test" command that is not the canonical one\n` +
          `    expected: ${expected.test}\n` +
          `    npm_lifecycle_script: ${env.npm_lifecycle_script}\n` +
          "    package.json on disk disagrees with the command npm loaded.",
      );
    }
  }
  return problems;
}

/**
 * Environment for the processes this gate spawns. Inheriting the caller's
 * environment wholesale hands a hostile `test` command control of what the
 * children DO, which defeats the point of the gate running them:
 *
 *  - NODE_OPTIONS carries `--require`/`--import`/`--experimental-loader`, so a
 *    preload can no-op the validator by inspecting `process.argv[1]` — the gate
 *    then announces validation, runs the suites and exits 0 having validated
 *    nothing.
 *  - NODE_REPL_EXTERNAL_MODULE is a second load-arbitrary-code vector.
 *  - NODE_TEST_CONTEXT makes a spawned `node --test` emit no report and exit 0
 *    even when suites FAIL (it is set in every test-file process and inherited
 *    by that process's children).
 *
 * Denied rather than allow-listed: an allow-list of everything a child may need
 * is unenumerable, and getting it wrong breaks legitimate runs. This is a short,
 * closed list of ways to change what a child EXECUTES.
 *
 * Matched case-INSENSITIVELY, and by rebuilding rather than deleting. Windows
 * resolves environment names case-insensitively, but `{ ...process.env }` is an
 * ordinary object with ordinary case-sensitive keys: a caller who spells it
 * `node_test_context` survives three uppercase `delete`s and is still
 * `NODE_TEST_CONTEXT` to the child. Copying only what passes the filter cannot
 * miss a spelling that way. `__proto__` is dropped for the same class of reason:
 * assigning it would set the new object's prototype instead of adding a variable.
 */
const CHILD_ENV_DENYLIST = new Set(["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "NODE_TEST_CONTEXT"]);

export function childEnv(source) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (name === "__proto__") continue;
    if (!CHILD_ENV_DENYLIST.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

// Run as gate + runner only when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const inventory = inventorySuites(join(ROOT, "test"));
  const problems = [...checkScripts(pkg, inventory, process.env), ...coverageProblems(inventory, ROOT)];
  if (problems.length) {
    process.stderr.write(`Test-script check failed:\n- ${problems.join("\n- ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `package.json scripts are canonical; running validation and exactly the ${inventory.length} suite(s) under test/.\n`,
  );
  // argv, not shell text: the paths are handed to node as separate arguments.
  const env = childEnv(process.env);

  const spawn = (label, args) => {
    const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", shell: false, env });
    if (run.error) {
      process.stderr.write(`Failed to run ${label}: ${run.error.message}\n`);
      process.exit(1);
    }
    if (run.status !== 0) process.exit(run.status === null ? 1 : run.status);
  };

  // Validation first, performed here rather than named in the `test` command.
  spawn("manifest validation", ["scripts/validate-manifests.mjs"]);
  spawn("the suites", ["--test", ...inventory]);
}
