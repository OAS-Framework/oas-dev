import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  ROOT, canonicalScripts, checkScripts, childEnv, coverageProblems, inventoryProblems, inventorySuites,
} from "../scripts/check-test-scripts.mjs";

/**
 * Tests for the gate/runner in scripts/check-test-scripts.mjs — ONE
 * implementation, exercised here and enforcing itself there before the suites
 * run.
 *
 * Enforcement has to live OUTSIDE the test run: a selection flag can exclude
 * the very assertion that would report it, so a check that only exists as a
 * test is a check the defect can silence. The unit tests below pin the gate's
 * logic; the END-TO-END tests run the real script in a throwaway repository,
 * because two of its properties are true only of the process — which suites
 * actually execute, and what npm loaded before it started.
 *
 * COVERAGE, stated precisely rather than generously:
 *  - REJECTED_TEST_COMMANDS is the accumulated table of `test`-command
 *    spellings that defeated earlier designs. Every row must produce a problem.
 *  - Inventory-level cases (empty, shell-significant paths) and script-set
 *    cases (an extra script, a missing one, a pretest) have dedicated tests,
 *    because they vary the INVENTORY or the script map rather than the command.
 *  - "A suite silently dropped from the command" is no longer expressible: the
 *    command names no suites at all, the runner passes the inventory as argv,
 *    and the end-to-end tests pin what actually ran.
 */

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const inventory = () => inventorySuites(join(ROOT, "test"));

/**
 * Every `test`-command spelling that defeated a previous design. `SUITES` is
 * replaced with the REAL inventory, so no fixture can pass merely by naming
 * paths that do not exist.
 */
const REJECTED_TEST_COMMANDS = [
  ["bare discovery", "node --test"],
  ["a reporter flag and no suites", "node --test --test-reporter tap"],
  ["a selection option whose VALUE has a suite path's shape", "node --test --test-name-pattern SUITES"],
  ["an unenumerable value-taking option swallowing the suites", "node --test --redirect-warnings SUITES"],
  ["a BACKSLASH-ESCAPED option the shell unescapes", "node --test \\--redirect-warnings SUITES"],
  ["a quoted option the shell unquotes", 'node --test "--redirect-warnings" SUITES'],
  ["--test-only, which runs no ordinary tests", "node --test --test-only SUITES"],
  ["--test-skip-pattern", "node --test --test-skip-pattern=x SUITES"],
  ["--test-shard", "node --test --test-shard=1/2 SUITES"],
  ["a glob instead of explicit paths", "node --test test/*.test.mjs"],
  ["command substitution in the arguments", "node --test $(ls test/*.test.mjs)"],
  ["a variable expansion in the arguments", "node --test $SUITES"],
  ["quoted suite paths (rejected by design; see the gate's header)", 'node --test "test/oas-dev.test.mjs"'],
  // The bypasses that beat DETECTION: a second invocation hidden from any
  // scanner, sitting beside a perfectly valid one. The shell reassembles
  // `--test`, and that first process discovers everything on the machine.
  ["parameter expansion hiding an invocation", "node --te${UNSET}st && node --test SUITES"],
  ["command substitution hiding an invocation", "node --te$(printf st) && node --test SUITES"],
  ["a line continuation hiding an invocation", "node --te\\\nst && node --test SUITES"],
  ["an extra bare invocation after a valid one", "node --test SUITES && node --test"],
  ["an extra bare invocation before a valid one", "node --test && node --test SUITES"],
  ["the gate invoked, then bare discovery anyway", "node scripts/check-test-scripts.mjs && node --test"],
  // The v1 spelling of this repository's own `test` script: naming validation
  // in the command is what let a re-spelling skip it.
  ["validation named in the command instead of performed by the gate",
   "npm run validate && node scripts/check-test-scripts.mjs"],
  ["the gate invoked through a shell that could re-read the paths",
   "sh -c 'node scripts/check-test-scripts.mjs'"],
];

/** Suite paths that must never be spliced into a command. */
const UNSAFE_SUITE_PATHS = [
  ["shell metacharacters that drop the suite and stay green", "test/ ; true #.test.mjs"],
  ["a space, which splits into two arguments", "test/a b.test.mjs"],
  ["command substitution", "test/$(id).test.mjs"],
  ["a variable expansion", "test/$HOME.test.mjs"],
  ["a parent-directory traversal", "test/../evil.test.mjs"],
  ["a single quote", "test/a'.test.mjs"],
  ["a double quote", 'test/a".test.mjs'],
  ["a backslash", "test/a\\b.test.mjs"],
  ["a newline", "test/a\nb.test.mjs"],
  ["a pipe", "test/a|b.test.mjs"],
  ["a path outside test/", "other/a.test.mjs"],
  ["an absolute path", "/etc/a.test.mjs"],
];

test("this repository's own scripts are exactly canonical", () => {
  assert.deepEqual(checkScripts(pkg, inventory()), []);
  assert.deepEqual(pkg.scripts, canonicalScripts(inventory()));
  // The `test` command must invoke the gate and nothing else — no `&&` chain in
  // which whatever runs the string decides which halves happen.
  assert.equal(pkg.scripts.test, "node scripts/check-test-scripts.mjs");
});

test("every known bypass spelling is rejected", () => {
  const suites = inventory();
  for (const [label, template] of REJECTED_TEST_COMMANDS) {
    const command = template.replaceAll("SUITES", suites.join(" "));
    const problems = checkScripts({ scripts: { ...canonicalScripts(suites), test: command } }, suites);
    assert.ok(problems.length, `MUST be rejected but was accepted — ${label}: ${JSON.stringify(command)}`);
  }
});

test("a hidden second invocation cannot ride along with a valid one", () => {
  // The case that defeated every detector: the gate never sees an invocation to
  // check, so anything undetected was implicitly allowed. Comparing the WHOLE
  // command, character for character, removes the question.
  const suites = inventory();
  const canonical = canonicalScripts(suites);
  const smuggled = `node --te\${UNSET}st && ${canonical.test}`;
  const problems = checkScripts({ scripts: { ...canonical, test: smuggled } }, suites);
  assert.ok(problems.some((p) => p.includes("not the canonical command")), problems.join(" | "));
});

test("an EMPTY inventory is refused, not blessed as canonical", () => {
  // `node --test` with zero paths IS bare discovery. A command built from an
  // empty inventory would compare equal to itself and pass, so deleting the last
  // suite would have blessed the exact defect this gate exists to prevent.
  assert.throws(() => canonicalScripts([]), /no suites found/);
  const problems = checkScripts({ scripts: {} }, []);
  assert.ok(problems.some((p) => p.includes("no suites found")), problems.join(" | "));
  assert.ok(inventoryProblems([]).length, "an empty inventory must be a problem on its own");
  assert.ok(inventoryProblems(undefined).length, "so must a missing one");
});

test("a shell-significant suite path is refused before any command is built", () => {
  for (const [label, path] of UNSAFE_SUITE_PATHS) {
    assert.ok(
      inventoryProblems([path]).length,
      `MUST be rejected but was accepted — ${label}: ${JSON.stringify(path)}`,
    );
    assert.throws(() => canonicalScripts([path]), /unsafe suite path/, label);
    const problems = checkScripts({ scripts: {} }, ["test/ok.test.mjs", path]);
    assert.ok(problems.some((p) => p.includes("unsafe suite path")), label);
  }
});

test("ordinary suite paths are still accepted", () => {
  // Non-vacuity for the test above: the safe grammar must admit real paths,
  // including nested ones, or the gate simply refuses to run anything.
  assert.deepEqual(inventoryProblems(["test/nested/deeper/a-b_c.1.test.mjs"]), []);
  assert.deepEqual(inventoryProblems(inventory()), [], "the real inventory must be safe");
});

test("an extra script is reported rather than ignored", () => {
  // The gate compares the WHOLE scripts block against a canonical set, because
  // anything it merely failed to RECOGNIZE would be implicitly allowed.
  const suites = inventory();
  const problems = checkScripts({
    scripts: { ...canonicalScripts(suites), smoke: `node --test ${suites[0]}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes('unexpected script "smoke"')), problems.join(" | "));
});

test("a pretest hook is reported, because it runs before the gate does", () => {
  const suites = inventory();
  for (const hook of ["pretest", "posttest", "prepare"]) {
    const problems = checkScripts({ scripts: { ...canonicalScripts(suites), [hook]: "node evil.mjs" } }, suites);
    assert.ok(problems.some((p) => p.includes(`unexpected script "${hook}"`)), hook);
  }
});

test("a missing script is reported", () => {
  const suites = inventory();
  const { probe, ...withoutProbe } = canonicalScripts(suites);
  assert.ok(probe, "the canonical set must have a probe script to remove");
  const problems = checkScripts({ scripts: withoutProbe }, suites);
  assert.ok(problems.some((p) => p.includes('missing script "probe"')), problems.join(" | "));
});

test("an inherited script name cannot pose as a declared one", () => {
  // `"constructor" in {}` is true — so are toString, valueOf and six more. An
  // `in`-based lookup would treat an inherited FUNCTION as the declared command
  // and skip the comparison that is the whole point of this gate.
  const suites = inventory();
  const scripts = Object.create({ validate: canonicalScripts(suites).validate });
  Object.assign(scripts, { test: canonicalScripts(suites).test, probe: canonicalScripts(suites).probe });
  const problems = checkScripts({ scripts }, suites);
  assert.ok(problems.some((p) => p.includes('missing script "validate"')), problems.join(" | "));
});

test("an UNSPOOFED mismatch between the loaded command and package.json is reported", () => {
  // npm resolves the lifecycle command BEFORE running it, so the file the gate
  // reads and the command npm is running can disagree. This is a consistency
  // check and nothing more: the loaded command controls the environment of
  // everything it spawns, so it can override the value its child sees. The
  // forgery is exercised, and asserted to SUCCEED, further down.
  const suites = inventory();
  const canonical = canonicalScripts(suites);
  const problems = checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "test",
    npm_lifecycle_script: "node rewrite-package-json.mjs && node scripts/check-test-scripts.mjs && node --test",
  });
  assert.ok(problems.some((p) => p.includes("npm_lifecycle_script")), problems.join(" | "));

  // Non-vacuity: the matching command must pass, and an unrelated lifecycle
  // event must not be compared against the `test` command.
  assert.deepEqual(checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "test", npm_lifecycle_script: canonical.test,
  }), []);
  assert.deepEqual(checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "probe", npm_lifecycle_script: canonical.probe,
  }), []);
});

// ---------------------------------------------------------------------------
// The inventory must equal what is on DISK.
// ---------------------------------------------------------------------------

test("the suite inventory really is recursive", (t) => {
  // Built under a UNIQUE temp root, never in the real checkout: a fixed
  // directory here plus a recursive delete would silently destroy a real file
  // while still reporting green.
  const tempRoot = mkdtempSync(join(tmpdir(), "oas-dev-inventory-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  mkdirSync(join(tempRoot, "test", "nested", "deeper"), { recursive: true });
  writeFileSync(join(tempRoot, "test", "top.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "new.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "deeper", "deep.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "not-a-suite.txt"), "ignored\n");

  assert.deepEqual(inventorySuites(join(tempRoot, "test"), tempRoot), [
    "test/nested/deeper/deep.test.mjs",
    "test/nested/new.test.mjs",
    "test/top.test.mjs",
  ], "the inventory must walk every level and ignore non-suite files");
});

test("the inventory equals the suites on disk, so a new suite cannot go unrun", () => {
  // The gate names the inventory as argv. If the inventory could disagree with
  // the tree, adding a test file would silently not run it — the failure mode
  // that a `test` script listing suites by hand had, in a new place.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".test.mjs") ? [relative(ROOT, path).replaceAll("\\", "/")] : [];
  });
  const onDisk = walk(join(ROOT, "test")).sort();
  assert.deepEqual(inventory(), onDisk);
  assert.ok(onDisk.length > 0, "there must be suites to run");
  // And this very file is one of them, so the gate is running its own guards.
  assert.ok(onDisk.includes("test/npm-scripts.test.mjs"));
});

// ---------------------------------------------------------------------------
// COVERAGE: a file node WOULD discover that the gate would never run.
//
// The inventory is `test/**/*.test.mjs` and nothing else reaches the command,
// so every other spelling node treats as a test is a suite that silently never
// executes — green looks identical either way.
// ---------------------------------------------------------------------------

/** A throwaway tree with the given files (contents are irrelevant here). */
function tree(t, paths, links = []) {
  const root = mkdtempSync(join(tmpdir(), "oas-dev-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "// fixture\n");
  }
  for (const [linkPath, target] of links) {
    mkdirSync(dirname(join(root, linkPath)), { recursive: true });
    symlinkSync(join(root, target), join(root, linkPath));
  }
  return root;
}

test("this repository's own tree is fully covered by the inventory", () => {
  // The live assertion: whatever is on disk right now, nothing node would run
  // is left out of the command the gate builds.
  assert.deepEqual(coverageProblems(inventory(), ROOT), []);
});

/**
 * NODE'S DISCOVERY, AS MEASURED. Every row below was confirmed against node
 * v22.21.1 by planting the file and reading `node --test --test-reporter=tap`'s
 * subtest names — the gate's rule is only as good as the semantics it encodes,
 * and four of these rows were holes the previous rule left open.
 */
for (const [label, path] of [
  // --- NAME prong, outside a test directory
  ["a .test.js beside the suites", "test/legacy.test.js"],
  ["a .test.cjs beside the suites", "test/legacy.test.cjs"],
  ["a .test.mjs OUTSIDE test/", "lib/parser.test.mjs"],
  ["a .test.js at the repository root", "foo.test.js"],
  ["node's dash convention", "test/parser-test.mjs"],
  ["node's underscore convention", "test/parser_test.mjs"],
  ["node's test- prefix convention", "test/test-parser.mjs"],
  ["a bare test.mjs in a source directory", "scripts/test.mjs"],
  ["an empty affix, which node still matches", "lib/-test.mjs"],
  ["a type-stripped .ts suite", "lib/parser.test.ts"],
  ["a type-stripped .mts suite", "lib/parser.test.mts"],
  ["node's case-insensitive name match", "lib/parser.Test.mjs"],
  // --- DIRECTORY prong: node runs EVERY script file under a `test` directory,
  // at any depth, whatever its name. Each of these was silently missed before.
  ["a `test` directory inside lib/", "lib/test/parser.mjs"],
  ["a `test` directory inside a package", "packages/foo/test/bar.mjs"],
  ["a `test` directory nested two levels down, with its own subtree", "a/b/test/c/suite.mjs"],
  ["a name-less module in a subdirectory OF test/", "test/lib/helper.mjs"],
  ["the former 'helper module' exemption, which node executes", "test/helpers/build-fixture.mjs"],
  ["a .ts file under a test directory", "test/support/harness.ts"],
]) {
  test(`coverage guard reports ${label}`, (t) => {
    const root = tree(t, ["test/alpha.test.mjs", path]);
    const problems = coverageProblems(["test/alpha.test.mjs"], root);
    assert.equal(problems.length, 1, `MUST be reported — ${label}: ${path}\n${problems.join("\n")}`);
    assert.match(problems[0], /DISCOVERS but this gate never runs/);
    assert.ok(problems[0].includes(path), problems[0]);
  });
}

test("coverage guard leaves ordinary files and excluded trees alone", (t) => {
  // Non-vacuity in every direction the exclusion list claims. A rule this broad
  // has to be shown NOT firing, or it is indistinguishable from "fail always".
  // Every row is a spelling node was confirmed NOT to discover.
  const root = tree(t, [
    "test/alpha.test.mjs",
    "test/nested/beta.test.mjs",
    "test/fixtures/child-oas-config.yaml",        // fixture DATA, not a script
    "scripts/lib/config-portability.mjs",         // shared helper, outside test/
    "scripts/validate-manifests.mjs",             // ordinary source
    "README.md",
    "lib/testfoo.mjs",                            // no separator: not node's convention
    "lib/test_foo.mjs",                           // `test_` is a PREFIX node does not honour
    "lib/parser.test.jsx",                        // not a runtime extension
    "tests/plural.mjs",                           // the directory must be named exactly `test`
    "realtest/x.mjs",
    "node_modules/some-dep/index.test.js",        // installed tree
    "node_modules/some-dep/test/thing.js",
    ".git/hooks/pre-commit.mjs",                  // node skips dot-prefixed entries
    ".hidden/test/suite.mjs",
    // Another instance's checkout: a foreign work tree at another revision, and
    // the exact tree this gate exists to keep OUT of the run.
    "agents/oas-dev-expert/instances/x/work/test/stale.test.mjs",
  ]);
  assert.deepEqual(coverageProblems(["test/alpha.test.mjs", "test/nested/beta.test.mjs"], root), []);
});

test("the instance exemption is the <id> DIRECTORY, not everything under instances/", (t) => {
  // The exemption is documented as `agents/<soul>/instances/<id>/` — a foreign
  // checkout at another revision. The test was `segments.length > 2`, which
  // matched `agents/<soul>/instances` itself, so the walk never entered it and a
  // file dropped straight into `instances/` — OURS, at OUR revision — was exempt
  // too. `node --test` would have run it; the gate would never have named it.
  const reported = tree(t, ["test/alpha.test.mjs", "agents/soul/instances/a.test.mjs"]);
  const problems = coverageProblems(["test/alpha.test.mjs"], reported);
  assert.equal(problems.length, 1, `a file directly in instances/ MUST be reported\n${problems.join("\n")}`);
  assert.ok(problems[0].includes("agents/soul/instances/a.test.mjs"), problems[0]);
  assert.match(problems[0], /DISCOVERS but this gate never runs/);

  // The other direction, immediately beside it: the real foreign checkout — and
  // everything at any depth below it — stays exempt, or this narrowing would
  // have made the gate red on every machine with a live instance.
  const exempt = tree(t, [
    "test/alpha.test.mjs",
    "agents/soul/instances/x/work/test/y.test.mjs",
    "agents/soul/instances/x/work/lib/parser.test.mjs",
    "agents/soul/instances/x/notes/deep/tree/z.test.mjs",
  ]);
  assert.deepEqual(coverageProblems(["test/alpha.test.mjs"], exempt), []);
});

test("coverage guard REFUSES a symlinked directory under a test tree", (t) => {
  // NOBODY follows it: node does not traverse a symlinked directory, and readdir
  // reports a link rather than a directory, so inventorySuites' recursion skips
  // the whole subtree. Every suite under it runs nowhere while the tree still
  // looks populated. Fail closed, as the kernel does for a symlinked package
  // resource.
  const root = tree(t, ["test/alpha.test.mjs", "extra/gamma.test.mjs"], [["test/suites", "extra"]]);
  // First: prove the hole is real — the inventory does NOT see the linked tree.
  assert.deepEqual(inventorySuites(join(root, "test"), root), ["test/alpha.test.mjs"],
    "the inventory must really miss a symlinked directory, or refusing one proves nothing");
  const problems = coverageProblems(inventorySuites(join(root, "test"), root), root);
  assert.ok(problems.some((p) => /symlinked directory "test\/suites" under a test\/ tree/.test(p)),
    problems.join("\n"));
  // The link's TARGET is reported on its own too — it is an uninventoried suite
  // wherever it sits, and the two findings are independent.
  assert.ok(problems.some((p) => p.includes("extra/gamma.test.mjs")), problems.join("\n"));
});

test("coverage guard REFUSES a symlinked test FILE, which node follows and runs", (t) => {
  // The other symlink direction, and the opposite behaviour: node FOLLOWS a
  // symlinked file. `test/helper.mjs -> ../elsewhere/suite.mjs` is discovered by
  // the directory prong and executed under bare discovery, while the gate's walk
  // used to skip every symlink outright and the inventory only ever names
  // `*.test.mjs`. So it ran under `node --test` and never under `npm test`.
  const root = tree(t, ["test/alpha.test.mjs", "elsewhere/suite.mjs"],
    [["test/helper.mjs", "elsewhere/suite.mjs"]]);
  const problems = coverageProblems(inventorySuites(join(root, "test"), root), root);
  assert.ok(problems.some((p) => /symlinked test file "test\/helper\.mjs"/.test(p)), problems.join("\n"));
  // …and a symlinked file node would NOT discover is left alone, or the rule is
  // just "no symlinks" wearing a discovery argument.
  const benign = tree(t, ["test/alpha.test.mjs", "elsewhere/notes.md"],
    [["docs.md", "elsewhere/notes.md"]]);
  assert.deepEqual(coverageProblems(["test/alpha.test.mjs"], benign), []);
});

test("the coverage guard runs INSIDE the gate, not only in this suite", (t) => {
  // Enforcement has to live outside the test run: a selection flag can exclude
  // the assertion that would report the defect. So the end-to-end fixture plants
  // an out-of-inventory suite and the real gate must refuse before anything runs.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "foo.test.js"), "// discoverable, never inventoried\n");
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /DISCOVERS but this gate never runs/);
  assert.ok(run.stderr.includes("foo.test.js"), run.stderr);
  assert.deepEqual(repo.ran(), [], "nothing may run while a discoverable suite is outside the inventory");
});

test("the gate also refuses a symlinked suite directory end to end", (t) => {
  const repo = fixtureRepo(t);
  mkdirSync(join(repo.root, "extra"), { recursive: true });
  writeFileSync(join(repo.root, "extra", "gamma.test.mjs"), "// never reached\n");
  symlinkSync(join(repo.root, "extra"), join(repo.root, "test", "suites"));
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /symlinked directory/);
  assert.deepEqual(repo.ran(), []);
});

test("the gate refuses a symlinked test FILE end to end — and bare discovery WOULD run it", (t) => {
  // Both halves, in one fixture. The planted link is a script file under test/,
  // so node's directory prong discovers it; the gate must refuse before the
  // suites run, and the bare-discovery half proves the refusal is not academic.
  const repo = fixtureRepo(t);
  mkdirSync(join(repo.root, "elsewhere"), { recursive: true });
  writeFileSync(join(repo.root, "elsewhere", "smuggled.mjs"), [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(repo.root, "markers", "smuggled"))}, "");`,
    "",
  ].join("\n"));
  symlinkSync(join(repo.root, "elsewhere", "smuggled.mjs"), join(repo.root, "test", "helper.mjs"));

  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /symlinked test file/);
  assert.deepEqual(repo.ran(), [], "nothing may run while a symlinked test file is in the tree");

  // Non-vacuity: bare discovery really does follow the link and execute it, so
  // the file the gate refuses is a file that otherwise runs behind its back.
  spawnSync(process.execPath, ["--test"], { cwd: repo.root, encoding: "utf8", env: childEnv(process.env) });
  assert.ok(repo.ran().includes("smuggled"),
    "node --test must follow the symlinked file, or refusing it proves nothing");
});

// ---------------------------------------------------------------------------
// End-to-end: the real script, in a throwaway repository.
// ---------------------------------------------------------------------------

/**
 * A minimal repository containing the REAL gate, two suites under test/, and a
 * decoy suite in a nested agent worktree — the exact layout bare discovery
 * mis-executes, and the reason this gate exists: an OAS checkout holds other
 * instances' worktrees at agents/<soul>/instances/<id>/work/, each a full
 * checkout at whatever revision that instance happens to be on.
 *
 * Each suite records that it ran by creating a marker file AT IMPORT TIME, so
 * the record survives any reporter, filter or test outcome.
 */
function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "oas-dev-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markers = join(root, "markers");
  mkdirSync(markers);

  const suite = (path, name) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), [
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      `writeFileSync(${JSON.stringify(join(markers, name))}, "");`,
      `test(${JSON.stringify(name)}, () => {});`,
      "",
    ].join("\n"));
  };

  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts", "check-test-scripts.mjs"), join(root, "scripts", "check-test-scripts.mjs"));
  writeFileSync(join(root, "scripts", "validate-manifests.mjs"), [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(markers, "validate"))}, "");`,
    "",
  ].join("\n"));
  suite("test/alpha.test.mjs", "alpha");
  suite("test/nested/beta.test.mjs", "beta");
  suite("agents/oas-dev-expert/instances/x/work/test/stale.test.mjs", "decoy");

  const suites = inventorySuites(join(root, "test"), root);
  assert.deepEqual(suites, ["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module", scripts: canonicalScripts(suites),
  }, null, 2));

  return {
    root,
    ran: () => readdirSync(markers).sort(),
    runGate: (env = {}) => spawnSync(process.execPath, ["scripts/check-test-scripts.mjs"], {
      cwd: root, encoding: "utf8", env: { ...process.env, ...env },
    }),
  };
}

test("end-to-end: the gate runs validation and exactly the inventoried suites", (t) => {
  const repo = fixtureRepo(t);
  const run = repo.runGate();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(repo.ran(), ["alpha", "beta", "validate"],
    "validation, every suite under test/, and nothing else — the decoy must NOT appear");
});

test("end-to-end: bare discovery WOULD have run the nested agent worktree", (t) => {
  // Non-vacuity for the test above. Without this, "the decoy did not run" could
  // be true merely because the decoy was undiscoverable in the first place.
  const repo = fixtureRepo(t);
  // NODE_TEST_CONTEXT has to be stripped by hand here: this spawn deliberately
  // bypasses the gate, and the gate is what strips it for real runs. Left in,
  // the child would emit nothing and exit 0 whatever happened.
  const run = spawnSync(process.execPath, ["--test"], {
    cwd: repo.root, encoding: "utf8", env: childEnv(process.env),
  });
  assert.ok(repo.ran().includes("decoy"),
    `bare discovery must reach the decoy for this comparison to mean anything: ${run.stdout}`);
});

test("end-to-end: an unforged lifecycle mismatch is reported before anything runs", (t) => {
  const repo = fixtureRepo(t);
  const run = repo.runGate({
    npm_lifecycle_event: "test",
    npm_lifecycle_script: "node rewrite.mjs && node scripts/check-test-scripts.mjs && node --test",
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /npm_lifecycle_script/);
  assert.deepEqual(repo.ran(), [], "the gate must refuse before running anything");
});

test("end-to-end: a suite whose NAME is shell syntax fails the gate", (t) => {
  // Spliced into a shell command, `; true #` would drop the suite and leave the
  // run green. The gate must refuse to build a command from it at all.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "test", " ; true #.test.mjs"), "// unsafe fixture\n");
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /unsafe suite path/);
  assert.deepEqual(repo.ran(), [], "nothing may run while the inventory is unsafe");
});

test("end-to-end: an empty test/ fails the gate instead of falling through to discovery", (t) => {
  const repo = fixtureRepo(t);
  rmSync(join(repo.root, "test"), { recursive: true, force: true });
  mkdirSync(join(repo.root, "test"));
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /no suites found/);
  assert.deepEqual(repo.ran(), [], "an empty inventory must never fall through to discovery");
});

test("end-to-end: a nonzero suite exit becomes the gate's exit code", (t) => {
  // The runner replaces `node --test` in the command; if it swallowed failures,
  // this gate would be reporting green over a red suite.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "test", "alpha.test.mjs"), [
    'import test from "node:test";',
    'test("failing", () => { throw new Error("boom"); });',
    "",
  ].join("\n"));
  const run = repo.runGate();
  assert.notEqual(run.status, 0, "a failing suite must fail the gate");
});

test("end-to-end: a failing validator stops the run before any suite", (t) => {
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "scripts", "validate-manifests.mjs"), "process.exit(3);\n");
  const run = repo.runGate();
  assert.equal(run.status, 3, "the validator's exit status must propagate");
  assert.deepEqual(repo.ran(), [], "no suite may run after validation fails");
});

test("end-to-end: a spoofed lifecycle variable cannot skip validation", (t) => {
  // Run through REAL npm. A noncanonical `test` rewrites package.json to
  // canonical and invokes the gate with a forged npm_lifecycle_script, so both
  // the file and the variable look right.
  //
  // That forgery still SUCCEEDS — the variable is a consistency check, not
  // attestation, and the gate's header says so. What it can no longer buy is
  // the prize: validation used to live in the command as `npm run validate &&
  // …`, where re-spelling the command skipped it. The gate performs it now.
  const repo = fixtureRepo(t);
  const canonical = canonicalScripts(["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(repo.root, "rewrite.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const p = new URL("./package.json", import.meta.url);',
    'const pkg = JSON.parse(readFileSync(p, "utf8"));',
    `pkg.scripts.test = ${JSON.stringify(canonical.test)};`,
    "writeFileSync(p, JSON.stringify(pkg, null, 2));",
    "",
  ].join("\n"));
  writeFileSync(join(repo.root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module",
    scripts: {
      ...canonical,
      test: `node rewrite.mjs && npm_lifecycle_script=${JSON.stringify(canonical.test)} `
        + "node scripts/check-test-scripts.mjs",
    },
  }, null, 2));

  const run = spawnSync("npm", ["test"], { cwd: repo.root, encoding: "utf8", env: childEnv(process.env) });
  assert.equal(run.status, 0, `the forgery is expected to pass the gate: ${run.stdout}${run.stderr}`);
  assert.ok(repo.ran().includes("validate"),
    "validation must run even when the lifecycle variable is forged — it is performed, not named");
  assert.ok(repo.ran().includes("alpha") && repo.ran().includes("beta"), "and the suites still run");
});

test("end-to-end: a NODE_OPTIONS preload cannot neutralize the validator", (t) => {
  // Performing a step is not enough if the caller controls what the step DOES.
  // NODE_OPTIONS carries --require, so a preload that exits when argv[1] is the
  // validator made the gate announce validation, run the suites and exit 0
  // having validated nothing. The gate BUILDS its children's environment now.
  const repo = fixtureRepo(t);
  const preload = { NODE_OPTIONS: `--require=${join(repo.root, "skip.cjs")}` };
  writeFileSync(join(repo.root, "skip.cjs"),
    'if (process.argv[1] && process.argv[1].endsWith("validate-manifests.mjs")) process.exit(0);\n');

  // FIRST, prove the exploit is real: inherited by a direct spawn, the preload
  // silently no-ops the validator. Without this the test below could pass
  // merely because the preload never worked.
  const bypassed = spawnSync(process.execPath, ["scripts/validate-manifests.mjs"], {
    cwd: repo.root, encoding: "utf8", env: { ...process.env, ...preload },
  });
  assert.equal(bypassed.status, 0);
  assert.deepEqual(repo.ran(), [], "the preload must really neutralize the validator when inherited");

  const run = repo.runGate(preload);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.ok(repo.ran().includes("validate"),
    `validation must run despite the preload: ${run.stdout}${run.stderr}`);
});

test("end-to-end: the full exploit — rewrite, forge and preload together — still validates", (t) => {
  // Every check the gate can make on its own inputs is made to pass; only the
  // rebuilt child environment stands between the announcement "running
  // validation" and validating nothing.
  const repo = fixtureRepo(t);
  const canonical = canonicalScripts(["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(repo.root, "skip.cjs"),
    'if (process.argv[1] && process.argv[1].endsWith("validate-manifests.mjs")) process.exit(0);\n');
  writeFileSync(join(repo.root, "rewrite.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const p = new URL("./package.json", import.meta.url);',
    'const pkg = JSON.parse(readFileSync(p, "utf8"));',
    `pkg.scripts.test = ${JSON.stringify(canonical.test)};`,
    "writeFileSync(p, JSON.stringify(pkg, null, 2));",
    "",
  ].join("\n"));
  writeFileSync(join(repo.root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module",
    scripts: {
      ...canonical,
      test: `node rewrite.mjs && npm_lifecycle_script=${JSON.stringify(canonical.test)} `
        + `NODE_OPTIONS=--require=./skip.cjs ${canonical.test}`,
    },
  }, null, 2));

  const run = spawnSync("npm", ["test"], { cwd: repo.root, encoding: "utf8", env: childEnv(process.env) });
  assert.ok(repo.ran().includes("validate"),
    `validation must run despite the preload: ${run.stdout}${run.stderr}`);
});

test("end-to-end: an inherited NODE_TEST_CONTEXT cannot silence failing suites", (t) => {
  // NODE_TEST_CONTEXT is set in every test-file process and inherited by that
  // process's children, so a `node --test` spawned from inside a test run emits
  // no report and exits 0 EVEN WHEN SUITES FAIL. Every gate run in this suite is
  // such a child; without the rebuild, all of them would be vacuous.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "test", "alpha.test.mjs"), [
    'import test from "node:test";',
    'test("failing", () => { throw new Error("boom"); });',
    "",
  ].join("\n"));

  // FIRST, prove the silencing is real, on the same failing suite.
  const silenced = spawnSync(process.execPath, ["--test", "test/alpha.test.mjs"], {
    cwd: repo.root, encoding: "utf8", env: { ...childEnv(process.env), NODE_TEST_CONTEXT: "child-v8" },
  });
  assert.equal(silenced.status, 0, "an inherited NODE_TEST_CONTEXT must really make a failing run exit 0");

  const run = repo.runGate({ NODE_TEST_CONTEXT: "child-v8" });
  assert.notEqual(run.status, 0, `a failing suite must fail the gate: ${run.stdout}${run.stderr}`);
});

test("childEnv removes every way to change what a child executes", () => {
  const env = childEnv({
    NODE_OPTIONS: "--require=./skip.cjs",
    NODE_REPL_EXTERNAL_MODULE: "./skip.cjs",
    NODE_TEST_CONTEXT: "child-v8",
    PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test" },
    "injection vectors stripped, ordinary environment preserved");
});

test("childEnv matches denied names case-insensitively", () => {
  // Windows resolves environment names case-insensitively, but the object
  // spread of process.env does not: a lowercase `node_test_context` would
  // survive an uppercase delete and still reach the child as NODE_TEST_CONTEXT.
  for (const name of [
    "node_test_context", "Node_Test_Context", "NODE_test_CONTEXT",
    "node_options", "Node_Options", "node_repl_external_module",
  ]) {
    assert.deepEqual(childEnv({ [name]: "x", KEEP: "y" }), { KEEP: "y" },
      `${name} must be stripped regardless of case`);
  }
  // Non-vacuity: names that merely RESEMBLE the denied ones are preserved.
  assert.deepEqual(
    childEnv({ NODE_ENV: "test", NODE_OPTIONS_EXTRA: "x", MY_NODE_OPTIONS: "y" }),
    { NODE_ENV: "test", NODE_OPTIONS_EXTRA: "x", MY_NODE_OPTIONS: "y" },
    "only exact names, case-insensitively, are denied");
});

test("childEnv drops __proto__ instead of setting a prototype", () => {
  // MUTATION-SENSITIVE, and it was not.
  //
  // The previous fixture passed `{ ["__proto__"]: "x" }`. Deleting the guard
  // makes that do `env["__proto__"] = "x"` — and assigning a PRIMITIVE to
  // __proto__ is a silent no-op: the prototype does not change and no own
  // property appears, so the assertions held with the guard removed. The test
  // was green either way, which is the same as having no test.
  //
  // An OBJECT value is what makes the assignment bite. JSON.parse produces a
  // genuine own "__proto__" data property (an object literal would not), so
  // this is also the shape a hostile environment dump would actually have.
  const source = JSON.parse('{"__proto__": {"polluted": "yes"}, "KEEP": "y"}');
  assert.ok(Object.hasOwn(source, "__proto__"), "the fixture must carry a real own __proto__ property");

  const env = childEnv(source);
  assert.deepEqual(env, { KEEP: "y" });
  assert.equal(Object.getPrototypeOf(env), Object.prototype,
    "without the guard, assigning this value would REPLACE the child environment's prototype");
  assert.equal(env.polluted, undefined,
    "and the child would then inherit a variable nobody set — invisible to Object.keys, visible to a lookup");
  assert.equal(Object.hasOwn(env, "__proto__"), false);
  assert.equal({}.polluted, undefined, "nothing may have reached Object.prototype");

  // The guard is per-object, so the primitive spelling must be handled too.
  const primitive = childEnv(JSON.parse('{"__proto__": "x", "KEEP": "y"}'));
  assert.deepEqual(primitive, { KEEP: "y" });
  assert.equal(Object.hasOwn(primitive, "__proto__"), false);
});
