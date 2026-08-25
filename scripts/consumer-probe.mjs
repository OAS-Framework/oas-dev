#!/usr/bin/env node
/**
 * Isolated CONSUMER probe: drive the RELEASED @oas-framework/oas kernel against
 * this repository's `oas-package/` payload exactly the way an adopter would.
 *
 *   node scripts/consumer-probe.mjs
 *
 *   OAS_PROBE_CLI   path to an already-unpacked kernel bin (skips the download)
 *   OAS_PROBE_KEEP  keep the sandbox even on success
 *
 * WHAT MAKES THIS DIFFERENT FROM THE LEAF PROBES. oas.dev is a PROFILE package:
 * its value is not one capability's bytes but a whole deployment — a config
 * template that binds three OTHER packages' capabilities plus its own. Nothing
 * a leaf probe asserts can show that the closure is right, because a leaf has
 * no closure. So the centre of this probe is a SYNTHETIC CATALOG: all five
 * official leaf packages pinned at their immutable v2 tag commits, served from
 * local bare clones over `file://`, with oas.dev pinned at this work tree's
 * exact HEAD. From that catalog the probe proves the closure in BOTH
 * directions — installing oas.dev locks exactly four packages and four
 * capabilities with oas.jira and oas.linear absent, and installing oas.jira
 * from the SAME catalog succeeds. Absence that a catalog gap could explain
 * proves nothing about dependency policy; absence beside a demonstrated
 * presence does.
 *
 * ISOLATION. Everything happens in a throwaway directory outside the source
 * tree, with a synthetic HOME and a PATH built from provisioned directories
 * only. The child environment is CONSTRUCTED, never inherited: every OAS_* and
 * PI_* variable is dropped (the operational dispatcher reads `instance.json`
 * through OAS_HOME/PI_AGENT_HOME and would resolve into this machine's real
 * deployment), HOME is replaced, and the only OAS_* variable set is the
 * documented OAS_PACKAGE_CATALOG override. Every executable the kernel may
 * resolve — the runtimes, `aw`, `tmux`, and `oas` itself — is a stub we own
 * that fails loudly and records the call, so "the probe never ran it" is
 * observed rather than assumed.
 *
 * NON-VACUITY. Every check named for a failure mode has a self-test that seeds
 * the failure and proves detection: the restore comparison is shown catching a
 * one-byte mutation, the pinned-ref assertions run against a branch head that
 * has ADVANCED past the pin, the shell-quoting guard is shown failing under the
 * quoting it replaced, and each stub is executed deliberately once so its
 * sentinel is known to fire before the run is judged by that sentinel's
 * silence.
 *
 * KNOWN KERNEL DEFECTS are recorded verbatim and worked around NOWHERE. A
 * package that patches around a kernel bug ships the bug's shape forever.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { portabilityLeaks } from "./lib/config-portability.mjs";
import { schemaProblems, unsupportedKeywords } from "./lib/json-schema.mjs";
import {
  RELEASE_TAG, acceptedSpellings, installSourceProblems, installSources, pinnedRef,
  quotedKernelMessages, refusedSpellings,
} from "./lib/readme-install-sources.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = join(REPO, "oas-package");
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(PAYLOAD, "oas-package.json"), "utf8"));
const CAPABILITY_MANIFEST = JSON.parse(readFileSync(join(PAYLOAD, "capabilities", "oas-review", "oas.json"), "utf8"));
/** The floor this package DECLARES is the kernel version it must be proved
 * against — never a constant maintained beside the manifest, which is how the
 * two drift. Note that the v0.20.0 TAG TREE self-reports 0.19.4; only the
 * PUBLISHED npm kernel reports 0.20.0, and this probe insists on that. */
const KERNEL_VERSION = String(PACKAGE_MANIFEST.compatibility.oas).replace(/^(>=|\^)/, "");

/** The immutable v2 leaf commits the synthetic catalog pins. Hard-coded on
 * purpose: reading them from whatever the local repositories happen to have
 * checked out would make the closure proof describe this machine instead of the
 * release. The fixture check below asserts each repository's v2.0.0 tag still
 * resolves to exactly these. */
const LEAF_PINS = {
  "oas.okf": { repo: "oas-okf", commit: "62010db1e524ab0e577ce39459ace731132b639f" },
  "oas.aweb": { repo: "oas-aweb", commit: "86a31a0f82dd221638a9a3061116ab278f409d08" },
  "oas.authoring": { repo: "oas-authoring", commit: "64bcc44b642a5b429385a810e6247242040c9686" },
  "oas.jira": { repo: "oas-jira", commit: "64ed25f60faa5a88aa87afb8dcb063efc828f3c1" },
  "oas.linear": { repo: "oas-linear", commit: "3c10a3664b2a74e3a2ddd81bad9ec28c6b0ad2ec" },
};
const LEAF_TAG = "v2.0.0";
/** The closure oas.dev must lock, and the four capabilities it must expose. */
const EXPECTED_PACKAGES = ["oas.authoring", "oas.aweb", "oas.dev", "oas.okf"];
const EXPECTED_CAPABILITIES = ["oas.authoring", "oas.aweb", "oas.okf", "oas.review"];
/** Adopter-selected task layers. They are catalog-resolvable and MUST NOT be in
 * oas.dev's closure — that is the policy this probe proves in both directions. */
const NON_DEPENDENCIES = ["oas.jira", "oas.linear"];
/**
 * Where the sibling leaf repositories live.
 *
 * Not simply `<repo>/..`: this repository is routinely checked out as a LINKED
 * WORKTREE somewhere else entirely (a release branch under /tmp, an agent's
 * work tree), and there the siblings are beside the PRIMARY checkout, not
 * beside the worktree. `git rev-parse --git-common-dir` always names the
 * primary checkout's `.git`, so its grandparent is the workspace root in both
 * layouts. Candidates are tried in order and the first that actually holds
 * every leaf wins; OAS_PROBE_WORKSPACE overrides all of it.
 */
const WORKSPACE = (() => {
  const candidates = [];
  if (process.env.OAS_PROBE_WORKSPACE) candidates.push(resolve(process.env.OAS_PROBE_WORKSPACE));
  candidates.push(resolve(REPO, ".."));
  try {
    const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    if (common) candidates.push(resolve(dirname(dirname(common))));
  } catch { /* not a git checkout — the preflight reports the consequence */ }
  const complete = candidates.find((root) =>
    Object.values(LEAF_PINS).every(({ repo }) => existsSync(join(root, repo, ".git"))));
  return complete || candidates[0];
})();

// ────────────────────────────────────────────────────────────── harness
const results = [];
let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ""}\n`);
  } catch (error) {
    failures += 1;
    results.push({ ok: false, name, detail: error.message });
    process.stdout.write(`  FAIL ${name}\n         ${String(error.message).split("\n").join("\n         ")}\n`);
  }
}
const step = (title) => process.stdout.write(`\n${title}\n`);
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}
function deepEqual(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected: ${b}\n  actual:   ${a}`);
}
/** Released-kernel behaviour this package must NOT work around, recorded
 * verbatim so the evidence travels with the run. */
const defects = [];
const defect = (title, evidence) =>
  defects.push(`  ${title}\n${String(evidence).split("\n").map((l) => `    ${l}`).join("\n")}`);

// ────────────────────────────────────────────────────────────── sandbox
const sandbox = mkdtempSync(join(tmpdir(), "oas-dev-consumer-probe-"));
let succeeded = false;
process.on("exit", () => {
  if (succeeded && !process.env.OAS_PROBE_KEEP) { rmSync(sandbox, { recursive: true, force: true }); return; }
  process.stdout.write(`\nsandbox kept for inspection: ${sandbox}\n`);
});
const HOME = join(sandbox, "home");
const SCRATCH = join(sandbox, "tmp");
mkdirSync(HOME, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

/**
 * POSIX single-quoting for a value interpolated into generated /bin/sh text.
 *
 * The sandbox path comes from TMPDIR, which the ENVIRONMENT controls, and it is
 * pasted into shell scripts this probe then executes — so an unquoted value is
 * a command-injection sink, not merely a spaces-in-paths bug. `JSON.stringify`
 * is JavaScript quoting and emits DOUBLE quotes, inside which `$`, backticks
 * and `$(...)` stay live; inside single quotes nothing is special, and the only
 * impossible character is `'` itself, closed and reintroduced as `'\''`.
 * Everything this probe writes into shell goes through here.
 */
const shq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** Every stub records a call it did not plan for here; the run fails at the end
 * if anything is left in it. A stub that silently returns 0 for an unplanned
 * call cannot fail a run it was never supposed to take part in. */
const UNEXPECTED = join(sandbox, "unexpected-invocations.log");
const AW_LOG = join(sandbox, "aw-calls.log");
const TMUX_LOG = join(sandbox, "tmux-calls.log");
const PI_LOG = join(sandbox, "pi-calls.log");
const PI_EXT = join(sandbox, "pi-packages", "awebai-pi");

/** A stub that answers exactly the calls named in `body` and REFUSES, loudly,
 * everything else — appending the unplanned call to `marker`. */
function stub(dir, name, body, marker = UNEXPECTED) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\nprintf '%s: %s\\n' ${shq(name)} "$*" >> ${shq(marker)}\nprintf '%s\\n' ${shq(`probe stub ${name}: unplanned call`)} >&2\nexit 90\n`);
  chmodSync(file, 0o755);
  return file;
}

// The stub BODIES are factories over the paths they write, so the hostile-path
// self-test can rebuild the same stubs over hostile paths instead of keeping a
// second copy of the shell text that would drift from these.
const TEAM = "oas-framework:probe.invalid";
const piBody = (log, ext) => `printf '%s\\n' "$*" >> ${shq(log)}
if [ "$1" = "list" ]; then printf '  npm:@awebai/pi\\n      %s\\n' ${shq(ext)}; exit 0; fi
if [ "$1" = "--list-models" ]; then exit 0; fi`;
const awBody = (log) => `printf '%s\\n' "$*" >> ${shq(log)}
case "$1 $2" in
  "team list") printf '{"active_team":"${TEAM}","memberships":[{"team_id":"${TEAM}"}]}\\n'; exit 0 ;;
  "team invite") printf '{"token":"probe-invite-token"}\\n'; exit 0 ;;
  "team join") printf '{"alias":"%s","team_id":"${TEAM}"}\\n' "$4"; exit 0 ;;
  "init "*|"init") mkdir -p .aw; exit 0 ;;
  "workspace delete") exit 0 ;;
esac`;
/** tmux is legitimately run by the kernel (retire closes the instance window)
 * and legitimately probed (`has-session`). What `--no-launch` must NEVER do is
 * CREATE a session or window, so this stub answers only the query/teardown
 * verbs and every session-creating verb falls through to the refusing
 * recorder. `has-session` exits 1: no session exists, and saying otherwise
 * would invite the kernel to attach to one. */
const tmuxBody = (log) => `printf '%s\\n' "$*" >> ${shq(log)}
case "$1" in
  has-session) exit 1 ;;
  list-sessions|list-windows|list-panes|kill-window) exit 0 ;;
esac`;

const NODE_DIR = join(sandbox, "node-only");
mkdirSync(NODE_DIR, { recursive: true });
symlinkSync(process.execPath, join(NODE_DIR, "node"));
const STUB_BIN = join(sandbox, "stub-bin");
mkdirSync(PI_EXT, { recursive: true });
writeFileSync(join(PI_EXT, "extension.mjs"), "// probe stand-in for the aweb pi extension\n");
stub(STUB_BIN, "pi", piBody(PI_LOG, PI_EXT));
stub(STUB_BIN, "aw", awBody(AW_LOG));
stub(STUB_BIN, "tmux", tmuxBody(TMUX_LOG));
/** No planned call at all. `claude` is a runtime nothing here selects, and
 * `oas` on PATH is the exact thing the kernel-identity check must not be able
 * to reach: the probe drives the kernel by ABSOLUTE PATH, and a PATH `oas` that
 * quietly worked would mean the whole run measured some other kernel. */
const REFUSE_ALL = ["claude", "oas"];
for (const name of REFUSE_ALL) stub(STUB_BIN, name, "");
const STUBBED = ["pi", "aw", "tmux", ...REFUSE_ALL];

/** The kernel's PATH: provisioned directories only. `/usr/bin:/bin` is there
 * for `git` and `sh`, which the kernel genuinely needs (it clones the file://
 * sources and shells out for the model probe) — everything the kernel could
 * resolve BESIDES those is a stub, ahead of them. */
const PROBE_PATH = `${NODE_DIR}:${STUB_BIN}:/usr/bin:/bin`;
/** A PATH for the probe's OWN helper commands (npm to fetch the kernel, git to
 * build fixtures). Deliberately separate: the kernel must never see npm. */
const TOOLS_BIN = join(sandbox, "tools-bin");
mkdirSync(TOOLS_BIN, { recursive: true });
for (const tool of ["node", "npm"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  if (found) symlinkSync(found, join(TOOLS_BIN, tool));
}
const TOOLS_PATH = `${TOOLS_BIN}:/usr/bin:/bin`;

/**
 * The child environment, CONSTRUCTED rather than filtered.
 *
 * A filtered copy of process.env is a denylist, and the list of ways this
 * agent's own OAS/pi context can reach a child is not enumerable: OAS_HOME,
 * OAS_INSTANCE, OAS_INSTANCE_HOME, PI_AGENT_HOME, PI_AGENTS_ROOT and friends
 * each redirect the kernel at the host's real deployment. Building the
 * environment from nothing means a variable that did not exist here cannot
 * appear there. HOME is replaced, not unset — an unset HOME makes git and node
 * resolve one from the passwd database, which is the host's again.
 */
function childEnv(extra = {}) {
  return {
    PATH: PROBE_PATH,
    HOME,
    TMPDIR: SCRATCH,
    NO_COLOR: "1",
    // Locale/proxy passthrough only, so a proxied or non-UTF-8 CI still works.
    ...Object.fromEntries(["LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
      .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    ...extra,
  };
}

/** git for the probe's OWN fixture building — never the kernel's git. */
function git(cwd, args) {
  return execFileSync("git", ["-c", "user.email=probe@example.invalid", "-c", "user.name=consumer probe", ...args], {
    cwd, encoding: "utf8", env: { PATH: TOOLS_PATH, HOME, TMPDIR: SCRATCH },
  }).trim();
}
function newScope(name) {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "scope"]);
  return dir;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lockOf = (scope) => readJson(join(scope, "oas-lock.json"));
const installedDir = (scope, id) => join(scope, ".agents", "capabilities", "installed", id);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ──────────────────────────────────────────────── preflight (fatal, not a check)
// Deliberately OUTSIDE check(): check() records a failure and carries on, which
// is right for a finding and wrong for a broken sandbox. If a controlled binary
// is reachable, every later assertion about refusal, isolation and spawn could
// resolve the REAL tool and pass for the wrong reason.
{
  const resolves = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { env: { PATH: PROBE_PATH }, encoding: "utf8" }).stdout.trim();
  const problems = [
    ...STUBBED.map((bin) => [bin, resolves(bin), join(STUB_BIN, bin)])
      .filter(([, found, mine]) => found !== mine)
      .map(([bin, found, mine]) => `  ${bin} resolves to ${found || "nothing"}, not the probe's stub at ${mine}`),
    ...["node", "git", "sh"].filter((bin) => !resolves(bin)).map((bin) => `  ${bin} is NOT reachable from the probe PATH`),
    ...(resolves("node") === join(NODE_DIR, "node") ? [] : [`  node resolves to ${resolves("node")}, not the provisioned symlink`]),
    ...(process.env.HOME === HOME ? ["  HOME was inherited rather than replaced"] : []),
    ...(existsSync(join(TOOLS_BIN, "npm")) || process.env.OAS_PROBE_CLI ? [] : ["  npm is not on this host, and OAS_PROBE_CLI was not supplied"]),
    ...Object.entries(LEAF_PINS).filter(([, { repo }]) => !existsSync(join(WORKSPACE, repo, ".git")))
      .map(([id, { repo }]) => `  ${id}: no git repository at ${join(WORKSPACE, repo)} (set OAS_PROBE_WORKSPACE)`),
  ];
  if (problems.length) {
    process.stderr.write(`PROBE ABORTED — the sandbox does not control what the kernel resolves:\n${problems.join("\n")}\n` +
      "Every verdict below would depend on this host rather than on the package.\n");
    process.exit(1);
  }
}

step("0. sandbox isolation");
check(`the probe PATH controls every executable the kernel may resolve (${STUBBED.join(", ")})`, () =>
  `PATH = ${PROBE_PATH}`);

check("every stub refuses and RECORDS a call the probe did not plan for", () => {
  // Runs before the stubs are used in anger, and baselines the marker
  // afterwards. Without this, a stub whose allowed branch swallowed the
  // fall-through would look identical to one that was simply never called
  // wrongly — and the final "nothing unexpected" check would prove nothing.
  for (const bin of STUBBED) {
    const run = spawnSync(join(STUB_BIN, bin), ["unplanned-probe-call"], { encoding: "utf8", env: childEnv() });
    equal(run.status, 90, `${bin} stub must fail an unplanned call loudly`);
  }
  const recorded = existsSync(UNEXPECTED) ? readFileSync(UNEXPECTED, "utf8") : "";
  for (const bin of STUBBED) {
    assert(recorded.includes(`${bin}: unplanned-probe-call`), `${bin} stub must RECORD the unplanned call; log was:\n${recorded}`);
  }
  // Baseline every sentinel this self-test just wrote to — the shared marker AND
  // the per-stub call logs, which each stub appends to BEFORE dispatching, so a
  // planned call and a refused one are both visible. From here on, anything in
  // any of them is a real finding rather than this test's own footprints.
  for (const log of [UNEXPECTED, AW_LOG, TMUX_LOG, PI_LOG]) rmSync(log, { force: true });
  return `${STUBBED.length} stubs exit 90 and record; sentinels baselined`;
});

check("EVERY generated stub quotes EVERY path it writes, apostrophes included", () => {
  // Cover every sink and both hostile spellings. A guard that exercised only
  // the shared marker, or used no apostrophe, stays green when shq() is dropped
  // from one call site or when its '\'' replacement breaks. Sinks × spellings.
  // `: > file` is a shell BUILTIN plus a redirect, so the injection fires even
  // though the probe PATH has no `touch`.
  const HOSTILE = "x ;: >INJECTED; #'q";
  const home = join(sandbox, "hostile-path-test");
  const bin = join(home, `bin ${HOSTILE}`);
  const arg = `an arg ${HOSTILE}`;
  const sideEffects = (dir) => (existsSync(dir) ? readdirSync(dir).filter((e) => e.startsWith("INJECTED")) : []);

  // Sink 1: the shared unexpected-call marker, written by stub()'s trailer.
  const marker = join(home, `marker ${HOSTILE}.log`);
  const victim = stub(bin, "victim", "", marker);
  const refused = spawnSync(victim, [arg], { cwd: home, encoding: "utf8", env: childEnv() });
  equal(refused.status, 90, `the stub must still refuse; stderr: ${refused.stderr}`);
  assert(existsSync(marker), `the marker must be written to the EXACT hostile path, not a split prefix (${marker})`);
  equal(readFileSync(marker, "utf8").trim(), `victim: ${arg}`, "recorded line");

  // Sink 2: the aweb call log, written by the REAL aw stub body.
  const awLog = join(home, `aw-calls ${HOSTILE}.log`);
  const aw = stub(bin, "aw-hostile", awBody(awLog), marker);
  const awRun = spawnSync(aw, ["team", "list"], { cwd: home, encoding: "utf8", env: childEnv() });
  equal(awRun.status, 0, `the aw stub must answer a planned call; stderr: ${awRun.stderr}`);
  equal(readFileSync(awLog, "utf8").trim(), "team list", "logged aw call at the exact hostile path");

  // Sink 3: the pi extension path, PRINTED by the REAL pi stub body, plus its log.
  const piLog = join(home, `pi-calls ${HOSTILE}.log`);
  const piExt = join(home, `pi-ext ${HOSTILE}`);
  const pi = stub(bin, "pi-hostile", piBody(piLog, piExt), marker);
  const piRun = spawnSync(pi, ["list"], { cwd: home, encoding: "utf8", env: childEnv() });
  equal(piRun.status, 0, `the pi stub must answer a planned call; stderr: ${piRun.stderr}`);
  assert(piRun.stdout.includes(piExt), `pi must print the EXACT extension path, got ${JSON.stringify(piRun.stdout)}`);
  equal(readFileSync(piLog, "utf8").trim(), "list", "logged pi call at the exact hostile path");

  // Sink 4: the tmux call log.
  const tmuxLog = join(home, `tmux-calls ${HOSTILE}.log`);
  const tmux = stub(bin, "tmux-hostile", tmuxBody(tmuxLog), marker);
  const tmuxRun = spawnSync(tmux, ["kill-window"], { cwd: home, encoding: "utf8", env: childEnv() });
  equal(tmuxRun.status, 0, `the tmux stub must answer a planned call; stderr: ${tmuxRun.stderr}`);
  equal(readFileSync(tmuxLog, "utf8").trim(), "kill-window", "logged tmux call at the exact hostile path");

  for (const dir of [home, bin]) deepEqual(sideEffects(dir), [], `no injected side-effect file in ${dir}`);
  assert(!existsSync(join(REPO, "INJECTED")), "no injected side-effect file in the repository");
  assert(!existsSync(join(sandbox, "INJECTED")), "no injected side-effect file in the sandbox root");
  return "4 sinks × hostile path with apostrophe: exact writes, no substitution executed";
});

check("the quoting guard would CATCH JavaScript quoting (non-vacuity)", () => {
  // The same stub built the old way must fail the same assertions, or the check
  // above proves only that single-quoting is self-consistent with itself.
  const dir = join(sandbox, "quoting-vacuity");
  mkdirSync(dir, { recursive: true });
  const sentinel = join(sandbox, "PWNED-VACUITY");
  const marker = join(dir, `marker $(: >${sentinel}).log`);
  const script = join(dir, "old-style.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(marker)}\nexit 90\n`);
  chmodSync(script, 0o755);
  spawnSync("sh", [script, "an-arg"], { cwd: dir, encoding: "utf8", env: childEnv() });
  assert(existsSync(sentinel), "JSON.stringify quoting MUST be exploitable here, or the guard above proves nothing");
  assert(!existsSync(marker), "JSON.stringify quoting must also lose the exact marker path");
  rmSync(sentinel, { force: true });
  return "JSON.stringify quoting confirmed exploitable — the guard above is real";
});

// ─────────────────────────────────────────────────────────── released kernel
step(`1. released kernel @oas-framework/oas@${KERNEL_VERSION}`);
const KERNEL = (() => {
  if (process.env.OAS_PROBE_CLI) return resolve(process.env.OAS_PROBE_CLI);
  const dir = join(sandbox, "kernel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "oas-probe-kernel", private: true, version: "0.0.0" }) + "\n");
  const install = spawnSync("npm", ["install", "--prefix", dir, `@oas-framework/oas@${KERNEL_VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: sandbox, encoding: "utf8",
    env: { PATH: TOOLS_PATH, HOME, TMPDIR: SCRATCH, npm_config_cache: join(sandbox, "npm-cache"), npm_config_update_notifier: "false" },
  });
  if (install.status !== 0) {
    process.stderr.write(`consumer probe could not install the released kernel:\n${install.stderr || install.stdout}\n`);
    process.exit(1);
  }
  return join(dir, "node_modules", "@oas-framework", "oas", "bin", "oas.mjs");
})();

/** Run the kernel BY ABSOLUTE PATH, under the constructed environment. */
function oas(args, { cwd = sandbox, path = PROBE_PATH, env = {}, expect = "ok" } = {}) {
  const run = spawnSync(process.execPath, [KERNEL, ...args], {
    cwd, encoding: "utf8", env: childEnv({ PATH: path, OAS_PACKAGE_CATALOG: CATALOG_FILE, ...env }),
  });
  const text = `${run.stdout || ""}${run.stderr || ""}`;
  if (expect === "ok" && run.status !== 0) throw new Error(`oas ${args.join(" ")} failed (${run.status}):\n${text}`);
  if (expect === "fail" && run.status === 0) throw new Error(`oas ${args.join(" ")} unexpectedly SUCCEEDED:\n${text}`);
  return { ...run, text };
}
/**
 * The `--json` envelope, which may legitimately be an `ok:false` one.
 *
 * Some commands print human notes first and some envelopes are pretty-printed
 * across many lines, so neither "the last line" nor "the first line" is the
 * envelope in general. Scan for the LAST suffix of stdout that parses as JSON,
 * considering only lines that start at column 0 — an envelope is never indented,
 * and allowing indented starts would let a nested object masquerade as one.
 */
function oasJson(args, options = {}) {
  const run = oas([...args, "--json"], options);
  const lines = (run.stdout || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/^[{]/.test(lines[i])) continue;
    try { return { ...JSON.parse(lines.slice(i).join("\n")), _text: run.text, _status: run.status }; }
    catch { /* not an envelope start */ }
  }
  throw new Error(`oas ${args.join(" ")} --json produced no envelope:\n${run.text}`);
}

// CATALOG_FILE is referenced by oas() above and assigned below; the catalog has
// to exist before the first kernel call that resolves through it, and `oas
// version` deliberately runs before it does (a missing catalog file reads as an
// empty catalog, which is exactly right for the identity checks).
let CATALOG_FILE = join(sandbox, "package-catalog.json");

check(`the kernel under test is the PUBLISHED ${KERNEL_VERSION}, invoked by absolute path`, () => {
  const version = oas(["version"]).stdout.trim();
  assert(version.includes(KERNEL_VERSION), `kernel reports "${version}", not ${KERNEL_VERSION} — the v0.20.0 TAG TREE self-reports 0.19.4, so this must be the npm release`);
  return version;
});

check("the kernel under test is NOT whatever `oas` the PATH resolves", () => {
  const onPath = spawnSync("sh", ["-c", "command -v oas"], { env: { PATH: PROBE_PATH }, encoding: "utf8" }).stdout.trim();
  equal(onPath, join(STUB_BIN, "oas"), "the PATH `oas` must be the probe's refusing stub");
  assert(resolve(KERNEL) !== resolve(onPath), `the probe must not be driving the PATH kernel (${onPath})`);
  // Non-vacuity: prove the PATH entry really is inert, so "we used the absolute
  // path" is a fact about behaviour and not just about two strings differing.
  const viaPath = spawnSync("oas", ["version"], { encoding: "utf8", env: childEnv() });
  equal(viaPath.status, 90, "the PATH `oas` must refuse, not answer");
  rmSync(UNEXPECTED, { force: true }); // that refusal was deliberate; baseline it out
  return `absolute ${KERNEL}; PATH oas = refusing stub`;
});

// ──────────────────────────── documentation and schemas, against the real kernel
step("1b. what the README tells consumers to type, and what this repo vendored — checked against the released kernel itself");

/** The unpacked kernel's own root: its `lib/` is the parser this package's
 * documentation must satisfy, and its `docs/` is where the vendored schemas
 * came from. Derived from the bin we are actually driving, so an
 * OAS_PROBE_CLI override is checked against ITS kernel, never against a
 * differently-versioned one that happens to be installed. */
const KERNEL_ROOT = resolve(dirname(KERNEL), "..");

/**
 * Parse specs with the RELEASED kernel's own `parsePackageSource`, in a CHILD
 * process.
 *
 * Not imported into this process on purpose: the probe's whole claim is that
 * it drives a kernel it did not build, and loading kernel modules into the
 * harness that judges them blurs exactly that line — a module-level side
 * effect would then be running inside the judge. The child gets the same
 * constructed environment every other kernel call gets.
 */
function parseSources(specs) {
  const script = join(sandbox, "parse-package-sources.mjs");
  writeFileSync(script, [
    `import { parsePackageSource } from ${JSON.stringify(pathToFileURL(join(KERNEL_ROOT, "lib", "core.mjs")).href)};`,
    "const out = [];",
    "for (const spec of process.argv.slice(2)) {",
    "  try { out.push({ spec, parsed: parsePackageSource(spec) }); }",
    "  catch (error) { out.push({ spec, error: { code: error.code, message: error.message } }); }",
    "}",
    "process.stdout.write(JSON.stringify(out));",
    "",
  ].join("\n"));
  const run = spawnSync(process.execPath, [script, ...specs], { encoding: "utf8", env: childEnv({ PATH: PROBE_PATH }) });
  if (run.status !== 0) throw new Error(`the kernel's own parser could not be invoked (${run.status}):\n${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

const README_TEXT = readFileSync(join(REPO, "README.md"), "utf8");

check("the README's install spellings satisfy the offline pinning rules", () => {
  // Same predicate the offline suite runs. Repeated here so a probe run is a
  // complete answer on its own: the parser checks below prove a spelling is
  // ACCEPTED, and an accepted spelling can still install last year's package.
  const problems = installSourceProblems(README_TEXT);
  assert(problems.length === 0, `README install spellings are unsound:\n  - ${problems.join("\n  - ")}`);
  return `${acceptedSpellings(README_TEXT).length} tabled + ${installSources(README_TEXT).length} runnable, all pinned to ${RELEASE_TAG}`;
});

check("every spelling the README documents is ACCEPTED by the released kernel's own parser", () => {
  const documented = [
    ...acceptedSpellings(README_TEXT).map(({ spelling, line }) => ({ spec: spelling, where: `spelling table, README:${line}` })),
    ...installSources(README_TEXT).map(({ source, line }) => ({ spec: source, where: `command, README:${line}` })),
  ];
  const byWhere = new Map(documented.map(({ spec, where }) => [spec, where]));
  const rows = [];
  for (const { spec, parsed, error } of parseSources([...new Set(documented.map((d) => d.spec))])) {
    const where = byWhere.get(spec);
    if (error) throw new Error(`${where}: the kernel REFUSES ${JSON.stringify(spec)} — ${error.code}: ${error.message}`);
    assert(["catalog", "git", "path"].includes(parsed.kind), `${where}: ${JSON.stringify(spec)} parsed as an unknown kind ${JSON.stringify(parsed.kind)}`);
    // A spelling that claims a pin must actually carry it into the parse — the
    // README's whole selector argument rests on the kernel seeing "v2.0.0".
    const pin = pinnedRef(spec);
    if (pin) {
      const carried = parsed.kind === "catalog" ? parsed.selector : parsed.ref;
      equal(carried, pin, `${where}: ${JSON.stringify(spec)} documents a ${RELEASE_TAG} pin the parser did not receive`);
    }
    if (parsed.kind === "git") assert(/^https:\/\/github\.com\/OAS-Framework\/oas-dev\.git$/.test(parsed.url), `${where}: ${JSON.stringify(spec)} resolves to ${parsed.url}, not this package's repository`);
    if (parsed.kind === "catalog") assert(/^oas\.(dev|jira)$/.test(parsed.id), `${where}: unexpected catalog id ${JSON.stringify(parsed.id)}`);
    rows.push(`${parsed.kind}:${spec}`);
  }
  return `${rows.length} spelling(s) accepted`;
});

check("every spelling the README documents as REFUSED is refused, with invalid-source", () => {
  const refused = refusedSpellings(README_TEXT);
  assert(refused.length >= 2, "the README must name both of the lock's normalized spellings as refused");
  const rows = [];
  for (const { spec, parsed, error } of parseSources(refused.map((r) => r.spelling))) {
    assert(!parsed, `the README says ${JSON.stringify(spec)} is refused, but the kernel ACCEPTED it as ${JSON.stringify(parsed)}`);
    equal(error.code, "invalid-source", `${JSON.stringify(spec)} was refused with an unexpected code`);
    rows.push(`${spec} → ${error.code}`);
  }
  return rows.join("; ");
});

check("the kernel messages the README QUOTES are the kernel's own, character for character", () => {
  // A paraphrase reads as documentation and is a lie about a program's output:
  // the previous README quoted "git shorthand must be git:host/org/repo[@ref][#path]",
  // dropping the angle brackets the kernel actually prints and the offending
  // spec it echoes back — so a reader matching the message against their
  // terminal would conclude they were seeing a different error.
  //
  // Only the kernel knows its own text, so this is the half of the check that
  // cannot live offline. The offline suite enforces that every refusal CARRIES
  // a quote; this one enforces what the quote says.
  const quoted = quotedKernelMessages(README_TEXT);
  const refused = refusedSpellings(README_TEXT);
  equal(quoted.length, refused.length, "each refused spelling must carry exactly one verbatim quote");
  const rows = [];
  for (const { spec, error } of parseSources(refused.map((r) => r.spelling))) {
    const match = quoted.find(({ message }) => message === error.message);
    assert(match, `README does not quote the kernel's message for ${JSON.stringify(spec)} verbatim.\n` +
      `  kernel:  ${JSON.stringify(error.message)}\n` +
      `  README:  ${quoted.map((q) => `README:${q.line} ${JSON.stringify(q.message)}`).join("\n           ")}`);
    rows.push(`README:${match.line} ✓`);
  }
  // And nothing is quoted that no spelling produces — a stale quote left behind
  // by an edit is the same defect pointing the other way.
  const kernelMessages = new Set(parseSources(refused.map((r) => r.spelling)).map((r) => r.error.message));
  for (const { message, line } of quoted) {
    assert(kernelMessages.has(message), `README:${line} quotes ${JSON.stringify(message)}, which no documented spelling produces`);
  }
  return rows.join(" ");
});

check(`the released ${KERNEL_VERSION} bundled catalog still names oas.dev v1.0.0 — why the README pins a selector`, () => {
  // The README's central install claim is that `oas.dev` alone installs v1 and
  // only `oas.dev@v2.0.0` installs this release. That is a fact about THIS
  // kernel's shipped catalog, so it is read from the kernel rather than
  // asserted in prose that nothing rechecks.
  const bundled = readJson(join(KERNEL_ROOT, "package-catalog.json"));
  const entry = bundled.packages["oas.dev"];
  assert(entry, "the released kernel's bundled catalog has no oas.dev entry at all");
  equal(entry.path, "oas-package", "the bundled catalog's contained package root");
  equal(bundled.capabilities["oas.review"], "oas.dev", "the bundled catalog must alias the exported capability to this package");
  assert(entry.ref !== `v${PACKAGE_MANIFEST.version}`,
    `the bundled catalog now names ${entry.ref} — it has been refreshed to this release, so the README's "a bare oas.dev installs v1" paragraph is stale and must be rewritten`);
  return `bundled ref ${entry.ref}; selector override required for v${PACKAGE_MANIFEST.version}`;
});

check("the vendored schemas are byte-identical to the published kernel's docs/", () => {
  // SCHEMA-STATUS.md claims provenance; this is that claim, executed. The
  // validator gates every manifest and the config template against these
  // files, so a drifted copy would gate against a contract nobody published.
  const rows = [];
  for (const name of readdirSync(join(REPO, "schemas")).sort()) {
    const mine = readFileSync(join(REPO, "schemas", name));
    const theirs = join(KERNEL_ROOT, "docs", name);
    assert(existsSync(theirs), `${name} is vendored here but absent from the published kernel's docs/ — it has no provenance`);
    equal(sha256(mine), sha256(readFileSync(theirs)), `schemas/${name} has drifted from the published kernel's copy`);
    rows.push(`${name}=${sha256(mine).slice(0, 8)}`);
  }
  assert(rows.length >= 3, "the schemas/ directory must hold the vendored package, capability and lock schemas");
  return rows.join(" ");
});

// ───────────────────────────────────────────────────── synthetic catalog
step("2. synthetic catalog — five leaves pinned at their immutable v2 tags, plus this work tree");
const BARE = join(sandbox, "origins");
mkdirSync(BARE, { recursive: true });
/** Bare clones over file://: hermetic (no network, no github) and exact. */
function bareClone(from, name) {
  const dest = join(BARE, `${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", from, dest], { encoding: "utf8", env: { PATH: TOOLS_PATH, HOME, TMPDIR: SCRATCH } });
  return dest;
}
const DEV_HEAD = git(REPO, ["rev-parse", "HEAD"]);
const catalogPackages = {};
for (const [id, { repo }] of Object.entries(LEAF_PINS)) {
  catalogPackages[id] = { url: `file://${bareClone(join(WORKSPACE, repo), repo)}`, ref: LEAF_TAG, path: "oas-package" };
}
catalogPackages["oas.dev"] = { url: `file://${bareClone(REPO, "oas-dev")}`, ref: DEV_HEAD, path: "oas-package" };
writeFileSync(CATALOG_FILE, JSON.stringify({ packages: catalogPackages, capabilities: { "oas.review": "oas.dev" } }, null, 2) + "\n");

check("every catalog origin pins the IMMUTABLE released leaf commit", () => {
  const rows = [];
  for (const [id, { repo, commit }] of Object.entries(LEAF_PINS)) {
    const origin = join(BARE, `${repo}.git`);
    equal(git(origin, ["rev-parse", `${LEAF_TAG}^{commit}`]), commit, `${id} ${LEAF_TAG} must be the immutable released commit`);
    const manifest = JSON.parse(git(origin, ["show", `${commit}:oas-package/oas-package.json`]));
    equal(manifest.package, id, `${id} manifest identity at the pinned commit`);
    rows.push(`${id}@${manifest.version}=${commit.slice(0, 8)}`);
  }
  equal(git(join(BARE, "oas-dev.git"), ["rev-parse", `${DEV_HEAD}^{commit}`]), DEV_HEAD, "oas.dev origin must carry this work tree's HEAD");
  return `${rows.join(" ")} oas.dev=${DEV_HEAD.slice(0, 8)}`;
});

check("the catalog resolves ALL FIVE leaves plus oas.dev, and aliases oas.review", () => {
  const doc = readJson(CATALOG_FILE);
  deepEqual(Object.keys(doc.packages).sort(), [...Object.keys(LEAF_PINS), "oas.dev"].sort(), "catalog package ids");
  deepEqual(doc.capabilities, { "oas.review": "oas.dev" }, "capability alias map");
  for (const entry of Object.values(doc.packages)) {
    assert(entry.url.startsWith("file://"), `catalog origins must be local file:// clones, got ${entry.url}`);
    equal(entry.path, "oas-package", "catalog package path");
  }
  return `${Object.keys(doc.packages).length} packages, oas.review → oas.dev`;
});

// ────────────────────────────────────────────── closure proof (both directions)
step("3. dependency closure — exactly the three declared dependencies, no task layer");
const profile = newScope("profile");
const init = oasJson(["init", "--package", "oas.dev", "--dir", profile]);

check("`oas init --package oas.dev` resolves the whole closure from the catalog", () => {
  assert(init.ok, `init failed: ${JSON.stringify(init.error)}`);
  equal(init.result.package, "oas.dev", "adopted package");
  equal(init.result.version, PACKAGE_MANIFEST.version, "adopted package version");
  equal(init.result.commit, DEV_HEAD, "oas.dev acquired at this work tree's HEAD");
  deepEqual([...init.result.capabilities].sort(), EXPECTED_CAPABILITIES, "capabilities the profile installs");
  return `${init.result.lockedPackages.length} packages, ${init.result.capabilities.length} capabilities`;
});

check("the lock records EXACTLY the four closure packages at the pinned commits", () => {
  const lock = lockOf(profile);
  equal(lock.lockfileVersion, 2, "lockfileVersion");
  deepEqual(Object.keys(lock.packages).sort(), EXPECTED_PACKAGES, "locked packages");
  for (const [id, { commit }] of Object.entries(LEAF_PINS)) {
    if (!EXPECTED_PACKAGES.includes(id)) continue;
    equal(lock.packages[id].commit, commit, `${id} locked commit is the immutable released one`);
    equal(lock.packages[id].source, `catalog:${id}@${LEAF_TAG}`, `${id} locked source keeps the dependency's own selector`);
    equal(lock.packages[id].path, "oas-package", `${id} locked package root`);
  }
  equal(lock.packages["oas.dev"].commit, DEV_HEAD, "oas.dev locked commit");
  deepEqual(lock.packages["oas.dev"].dependencies, ["oas.authoring", "oas.aweb", "oas.okf"],
    "oas.dev records its dependencies as SORTED package ids");
  for (const id of EXPECTED_PACKAGES) {
    assert(/^sha256-[0-9a-f]{64}$/.test(lock.packages[id].integrity), `${id} payload integrity`);
  }
  return Object.entries(lock.packages).map(([id, r]) => `${id}@${r.version}#${r.commit.slice(0, 8)}`).join(" ");
});

check("the lock records EXACTLY the four exported capabilities, each with a dedicated root", () => {
  const lock = lockOf(profile);
  deepEqual(Object.keys(lock.capabilities).sort(), EXPECTED_CAPABILITIES, "locked capabilities");
  equal(lock.capabilities["oas.review"].package, "oas.dev", "oas.review's provider package");
  equal(lock.capabilities["oas.review"].path, "capabilities/oas-review", "oas.review's dedicated capability root");
  for (const [id, row] of Object.entries(lock.capabilities)) {
    assert(row.path !== ".", `${id} must not use the package root as its capability root`);
    assert(row.path.startsWith("capabilities/"), `${id} capability root must be dedicated, got ${row.path}`);
    assert(Object.hasOwn(lock.packages, row.package), `${id} provider must be in the same packages map`);
    equal(row.trusted, false, `${id} must not be trusted by acquisition`);
  }
  return Object.entries(lock.capabilities).map(([id, r]) => `${id}←${r.package}`).join(" ");
});

check("the REAL generated lock validates against the vendored oas-lock schema", () => {
  // The lock schema was vendored and hashed for provenance but nothing ever
  // APPLIED it, so it was decorative: `schemas/oas-lock.schema.json` could have
  // described any shape at all and every gate would still have been green.
  //
  // Here it gates the actual document the released kernel just wrote for the
  // four-package closure — which is the only lock in this repository that was
  // not built by a test to match its own expectations.
  const schema = readJson(join(REPO, "schemas", "oas-lock.schema.json"));
  // A keyword the shared evaluator does not implement is silently ignored, so a
  // schema that grew one would validate LESS than it appears to. Checked first,
  // because everything below inherits that assumption.
  //
  // The report is POSITIONAL: this schema's `propertyNames: { minLength: 1 }` is
  // the case that proved a flat name check useless — `minLength` is implemented
  // at an ordinary schema position, so the old report said "covered" while the
  // evaluator read `propertyNames.pattern` and nothing else. Non-vacuity is
  // asserted right here, on this schema's own shape, so a regression to a flat
  // check cannot pass by returning an empty list.
  deepEqual(unsupportedKeywords(schema), [],
    "the vendored lock schema uses a keyword scripts/lib/json-schema.mjs does not implement — it would be silently skipped, weakening this check without changing its output");
  assert(unsupportedKeywords({ propertyNames: { maxLength: 3 } }).length,
    "unsupportedKeywords must report a keyword unsupported AT THE POSITION it appears, or its verdict above is worthless");

  const lock = lockOf(profile);
  const problems = schemaProblems(lock, schema, "oas-lock.json");
  assert(!problems.length, `the generated lock violates the vendored schema:\n  - ${problems.join("\n  - ")}`);

  // NON-VACUITY, three ways. A validator that accepts everything would pass the
  // assertion above just as happily, and each of these is a real corruption the
  // 0.20 lock contract exists to refuse.
  const seeded = [
    ["a malformed payload integrity", (l) => { l.packages["oas.dev"].integrity = "sha256-not-a-digest"; }],
    ["the unsupported transitional package-root shape", (l) => { l.packages["oas.dev"].capabilities = ["oas.review"]; }],
    ["a capability root spelled as a traversal", (l) => { l.capabilities["oas.review"].path = "../escape"; }],
    ["a missing required capability field", (l) => { delete l.capabilities["oas.review"].trusted; }],
    ["a lockfileVersion the contract does not define", (l) => { l.lockfileVersion = 3; }],
  ];
  for (const [label, corrupt] of seeded) {
    const copy = JSON.parse(JSON.stringify(lock));
    corrupt(copy);
    assert(schemaProblems(copy, schema, "oas-lock.json").length,
      `the vendored lock schema failed to catch ${label} — it is not gating anything`);
  }
  return `lockfileVersion ${lock.lockfileVersion}, ${Object.keys(lock.packages).length} packages, ${Object.keys(lock.capabilities).length} capabilities; ${seeded.length} seeded corruptions all caught`;
});

check(`the closure EXCLUDES ${NON_DEPENDENCIES.join(" and ")} from both lock maps`, () => {
  const lock = lockOf(profile);
  for (const id of NON_DEPENDENCIES) {
    assert(!Object.hasOwn(lock.packages, id), `${id} must NOT be a locked package of the oas.dev closure`);
    assert(!Object.hasOwn(lock.capabilities, id), `${id} must NOT be a locked capability of the oas.dev closure`);
    assert(!existsSync(installedDir(profile, id)), `${id} must not be materialized`);
  }
  deepEqual(PACKAGE_MANIFEST.dependencies, ["oas.okf@v2.0.0", "oas.aweb@v2.0.0", "oas.authoring@v2.0.0"],
    "the manifest itself must declare exactly the three dependencies");
  return `${NON_DEPENDENCIES.join(", ")} absent from packages and capabilities`;
});

const taskScope = newScope("task-layer-adopter");
check("…and that absence is POLICY, not a catalog gap: oas.jira installs from the SAME catalog", () => {
  // The other half of the proof. An absence that a missing catalog entry could
  // explain says nothing about dependency policy; an absence beside a
  // demonstrated presence, from the same catalog file in the same run, does.
  const jira = oasJson(["install", "oas.jira", "--dir", taskScope, "--no-requirements"]);
  assert(jira.ok, `oas.jira install failed: ${JSON.stringify(jira.error)}`);
  const lock = lockOf(taskScope);
  deepEqual(Object.keys(lock.packages), ["oas.jira"], "the task-layer scope locks oas.jira alone");
  deepEqual(Object.keys(lock.capabilities), ["oas.jira"], "and exactly its capability");
  equal(lock.packages["oas.jira"].commit, LEAF_PINS["oas.jira"].commit, "oas.jira resolves to its immutable released commit");
  equal(lock.capabilities["oas.jira"].path, "capabilities/oas-jira", "oas.jira dedicated capability root");
  // The adopter's own scope, not oas.dev's: the profile's lock is untouched.
  assert(!Object.hasOwn(lockOf(profile).packages, "oas.jira"), "installing oas.jira elsewhere must not touch the profile scope");
  return `oas.jira@${lock.packages["oas.jira"].version}#${lock.packages["oas.jira"].commit.slice(0, 8)} installs cleanly — the profile simply does not depend on it`;
});

// ──────────────────────────────────────────── pinned git source + default root
step("4. pinned Git acquisition and the default package root");
const pinnedFixture = (() => {
  const workDir = join(sandbox, "pinned-fixture");
  mkdirSync(join(workDir, "oas-package"), { recursive: true });
  cpSync(PAYLOAD, join(workDir, "oas-package"), { recursive: true });
  writeFileSync(join(workDir, "README.md"), "# decoy: the package is at oas-package/, not here\n");
  git(workDir, ["init", "-q", "-b", "main", "."]);
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-q", "-m", "payload at the pinned commit"]);
  const pin = git(workDir, ["rev-parse", "HEAD"]);
  // ADVANCE the branch past the pin, with a root-only change that leaves the
  // payload untouched. Without this, the pin and the branch head are the same
  // commit and every "pinned" assertion below holds for the wrong reason.
  writeFileSync(join(workDir, "NOTICE.md"), "the branch advanced after the pin; not payload\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-q", "-m", "advance the branch past the pin"]);
  const head = git(workDir, ["rev-parse", "HEAD"]);
  const origin = bareClone(workDir, "pinned-fixture");
  return { origin, pin, head };
})();

check("the fixture branch is ADVANCED past the pin, so pinning is testable at all", () => {
  assert(pinnedFixture.pin !== pinnedFixture.head, "pin and branch head are the same commit — ref pinning would be untestable");
  equal(git(pinnedFixture.origin, ["rev-parse", "HEAD"]), pinnedFixture.head, "the bare clone's branch head is the advanced commit");
  return `pin ${pinnedFixture.pin.slice(0, 8)} != branch head ${pinnedFixture.head.slice(0, 8)}`;
});

const pinnedScope = newScope("pinned-consumer");
check("a pinned file:// Git source locks the PINNED commit and the DEFAULT package root", () => {
  // No `#<path>` fragment is passed, deliberately: `oas-package` IS the released
  // kernel's default package path for a Git source, so this pins the DEFAULT
  // rather than an explicit selection — which is what the catalog entries and
  // the published install command both rely on.
  const spec = `file://${pinnedFixture.origin}@${pinnedFixture.pin}`;
  const installed = oasJson(["install", spec, "--dir", pinnedScope, "--no-requirements"]);
  assert(installed.ok, `pinned Git install failed: ${JSON.stringify(installed.error)}`);
  const row = lockOf(pinnedScope).packages["oas.dev"];
  equal(row.commit, pinnedFixture.pin, "locked commit is the pinned one");
  assert(row.commit !== pinnedFixture.head, `the lock must not follow the branch to ${pinnedFixture.head.slice(0, 8)}`);
  equal(row.path, "oas-package", "the DEFAULT contained package root was selected, not the repository root");
  equal(row.source, `git:file://${pinnedFixture.origin}@${pinnedFixture.pin}`, "the lock source is the normalized git:<url>@<ref> form");
  assert(!row.source.startsWith("path:"), "a Git source must never normalize as a path");
  return `commit ${row.commit.slice(0, 8)} (branch at ${pinnedFixture.head.slice(0, 8)}), path oas-package`;
});

check("dropping the ref locks the ADVANCED head, proving the pin did the work", () => {
  // Mutation proof. Same repository, same command, ref removed: if this still
  // locked the pinned commit, `@<sha>` would be decorative.
  const unpinned = newScope("unpinned-consumer");
  const installed = oasJson(["install", `file://${pinnedFixture.origin}`, "--dir", unpinned, "--no-requirements"]);
  assert(installed.ok, `unpinned Git install failed: ${JSON.stringify(installed.error)}`);
  const row = lockOf(unpinned).packages["oas.dev"];
  equal(row.commit, pinnedFixture.head, "without a ref the kernel must acquire the branch head");
  assert(row.commit !== pinnedFixture.pin, "pinned and unpinned installs must resolve to DIFFERENT commits");
  return `unpinned → ${pinnedFixture.head.slice(0, 8)}, pinned → ${pinnedFixture.pin.slice(0, 8)}`;
});

// ───────────────────────────────────────────────────────────── profile flow
step("5. the adopted profile");
const TEMPLATE_PATH = PACKAGE_MANIFEST.configTemplates.default.path;
const TEMPLATE_BYTES = readFileSync(join(PAYLOAD, TEMPLATE_PATH));
const adoptedBaseDir = join(profile, ".agents", "config-templates", "adopted", "oas.dev", "default");

check("the adopted config is the shipped template BYTE for byte (sha256)", () => {
  const adopted = readFileSync(join(profile, "oas-config.yaml"));
  const shipped = sha256(TEMPLATE_BYTES);
  equal(sha256(adopted), shipped, "adopted oas-config.yaml digest must equal the shipped template's");
  equal(sha256(readFileSync(join(adoptedBaseDir, "oas-config.yaml"))), shipped, "recorded base digest");
  assert(TEMPLATE_PATH.startsWith("config-templates/"), `the template must live under the canonical root, got ${TEMPLATE_PATH}`);
  return `sha256-${shipped.slice(0, 16)}… (${TEMPLATE_BYTES.length} bytes)`;
});

check("adoption records the base and its metadata for `oas config diff`/`sync`", () => {
  const meta = readJson(join(adoptedBaseDir, "adoption.json"));
  equal(meta.package, "oas.dev", "adoption metadata package");
  equal(meta.template, "default", "adoption metadata template");
  equal(meta.templatePath, TEMPLATE_PATH, "adoption metadata template path");
  equal(meta.version, PACKAGE_MANIFEST.version, "adoption metadata version");
  const diff = oasJson(["config", "diff", "--dir", profile]);
  equal(diff.result.clean, true, "a freshly adopted config has no drift from its base");
  return `base + adoption.json recorded, diff clean`;
});

check("the adopted config carries no credential and no machine-local path", () => {
  // The SAME predicate the manifest validator uses, so the gate the package
  // ships under and the gate an adopter actually experiences cannot drift.
  const text = readFileSync(join(profile, "oas-config.yaml"), "utf8");
  const leaks = portabilityLeaks(text);
  assert(!leaks.length, `the adopted config is not portable — it ${leaks.join("; it ")}`);
  // Non-vacuity: the predicate must actually fire on a seeded leak.
  assert(portabilityLeaks(`${text}\n  injection-override: /opt/acme/review.md\n`).length,
    "the portability predicate failed to flag a seeded absolute path");
  return "portable: no key, account, host path";
});

check("doctor resolves the profile's layers: knowledge oas.okf, messaging oas.aweb, tasks none", () => {
  const doctor = oasJson(["doctor", profile]);
  equal(doctor.layers.knowledge.integration, "oas.okf", "knowledge layer binding");
  equal(doctor.layers.messaging.integration, "oas.aweb", "messaging layer binding");
  assert(!doctor.layers.tasks.integration, `tasks must be explicitly none, got ${JSON.stringify(doctor.layers.tasks)}`);
  assert(/\bnone\b/.test(doctor.layers.tasks.provenance || ""), `tasks provenance must record the explicit none: ${doctor.layers.tasks.provenance}`);
  equal(doctor.team.name, "oas-framework", "the template's team block drives the deployment boundary");
  assert(doctor.layers.knowledge.inject.includes(`installed${"/"}oas.okf/injects/`), "the knowledge injection resolves inside the materialized artifact");
  assert(doctor.layers.messaging.inject.includes(`installed${"/"}oas.aweb/injects/`), "the messaging injection resolves inside the materialized artifact");
  deepEqual(Object.keys(doctor.acquired).sort(), EXPECTED_CAPABILITIES, "doctor sees exactly the four acquired capabilities");
  return "knowledge oas.okf, messaging oas.aweb, tasks none";
});

check("a second `oas init --package` at the same scope is refused with E_CONFIG_EXISTS", () => {
  const second = oasJson(["init", "--package", "oas.dev", "--dir", profile], { expect: "fail" });
  equal(second.ok, false, "the second init must not succeed");
  equal(second.error.code, "E_CONFIG_EXISTS", "refusal code");
  // The refusal must be inert: the first adoption's bytes are still exactly the
  // template, so nothing was rewritten on the way to failing.
  equal(sha256(readFileSync(join(profile, "oas-config.yaml"))), sha256(TEMPLATE_BYTES), "the existing config must be untouched by the refusal");
  return second.error.code;
});

// ───────────────────────────────────────────────────────────── exact restore
step("6. exact restore");
/** Relative paths of every entry in a tree. */
const walk = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
));
/** Kind, mode and content hash per path: the lock's integrity string proves only
 * that the LOCK did not move, so proving the restored BYTES are the same needs
 * an independent record. */
function snapshotTree(dir) {
  const snapshot = {};
  for (const rel of walk(dir).sort()) {
    const path = join(dir, rel);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { snapshot[rel] = `symlink:${readlinkSync(path)}`; continue; }
    snapshot[rel] = `file:${(stat.mode & 0o777).toString(8)}:${sha256(readFileSync(path))}`;
  }
  return snapshot;
}
const describeDrift = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter((k) => before[k] !== after[k])
  .map((k) => `${k}: ${before[k] === undefined ? "ADDED" : after[k] === undefined ? "MISSING" : "CHANGED"}`)
  .join("; ");

check("bare `oas install` restores a DELETED capability artifact byte-identically", () => {
  const artifact = installedDir(profile, "oas.review");
  const before = snapshotTree(artifact);
  assert(Object.keys(before).length > 3, "the snapshot should cover the whole artifact");
  const lockBefore = readFileSync(join(profile, "oas-lock.json"), "utf8");
  rmSync(artifact, { recursive: true, force: true });
  assert(!existsSync(artifact), "the artifact must be gone before the restore");
  const restored = oasJson(["install", "--dir", profile, "--no-requirements"]);
  assert(restored.ok, `bare restore failed: ${JSON.stringify(restored.error)}`);
  const drift = describeDrift(before, snapshotTree(artifact));
  assert(!drift, `restored artifact differs from the original bytes — ${drift}`);
  equal(readFileSync(join(profile, "oas-lock.json"), "utf8"), lockBefore, "a bare restore must not advance the lock by one byte");
  return `${Object.keys(before).length} files byte-identical; lock unchanged`;
});

check("the restore comparison would actually CATCH a corrupted artifact", () => {
  const artifact = installedDir(profile, "oas.review");
  const victim = join(artifact, "oas.json");
  const original = readFileSync(victim);
  const before = snapshotTree(artifact);
  writeFileSync(victim, Buffer.concat([original, Buffer.from("\n")]));
  const drift = describeDrift(before, snapshotTree(artifact));
  writeFileSync(victim, original);
  assert(/oas\.json: CHANGED/.test(drift), `the snapshot comparison failed to notice a mutated file (drift: ${drift || "none"})`);
  assert(!describeDrift(before, snapshotTree(artifact)), "restoring the original bytes should clear the drift");
  return "one-byte mutation detected";
});

// ───────────────────────────────────────────────────────────────── trust
step("7. trust");
check("oas.review declares NO executable surface, and trust says exactly that", () => {
  // Truthful, not aspirational: oas.review ships agents, skills and an
  // injection — no `commands`, no `hooks`. So `oas trust oas.review` approves
  // NOTHING, skips the capability, and the lock's `trusted` flag stays false,
  // because there is no executable surface for an approval to bind to. Asserting
  // an approval here would be inventing an effect the package does not have.
  assert(!CAPABILITY_MANIFEST.commands, "oas.review must declare no commands");
  assert(!CAPABILITY_MANIFEST.hooks, "oas.review must declare no hooks");
  const trust = oasJson(["trust", "oas.review", "--dir", profile]);
  assert(trust.ok, `trust failed: ${JSON.stringify(trust.error)}`);
  deepEqual(trust.result.approved, [], "nothing is approved — there is nothing executable to approve");
  deepEqual(trust.result.skipped, ["oas.review"], "the capability is reported as skipped");
  deepEqual(trust.result.executableSurface["oas.review"], { commands: [], hooks: [] }, "the reported surface is empty");
  equal(lockOf(profile).capabilities["oas.review"].trusted, false, "the lock's trusted flag stays false for a hook-less capability");
  const human = oas(["trust", "oas.review", "--dir", profile]).text;
  assert(/No executable surface \(artifact integrity suffices, no approval needed\): oas\.review/.test(human),
    `human output must say plainly that no approval was needed:\n${human}`);
  // And it is still USABLE: doctor reports no trust problem for it.
  const pkg = oasJson(["doctor", profile]).packages.find((p) => p.id === "oas.dev");
  deepEqual((pkg.problems || []).map((p) => p.code), [], `oas.dev must have no trust problem: ${JSON.stringify(pkg.problems)}`);
  return "approved [], skipped [oas.review], surface {commands:[],hooks:[]}, lock.trusted stays false";
});

const executableSurfaces = {};
check("the executable dependencies ARE gated, and `oas trust` binds each to its artifact", () => {
  // Non-vacuity for the check above: in the same lock, two capabilities DO have
  // executable surfaces, and their approvals behave completely differently.
  for (const id of ["oas.okf", "oas.aweb"]) {
    equal(lockOf(profile).capabilities[id].trusted, false, `${id} must be untrusted before approval`);
    const integrity = lockOf(profile).capabilities[id].integrity;
    const trust = oasJson(["trust", id, "--dir", profile]);
    assert(trust.ok, `trust ${id} failed: ${JSON.stringify(trust.error)}`);
    deepEqual(trust.result.approved, [id], `${id} must be approved`);
    equal(trust.result.approvedIntegrity[id], integrity, `${id} approval must bind to the MATERIALIZED artifact integrity`);
    assert(trust.result.executableSurface[id].hooks.includes("spawn"), `${id} declares a spawn hook`);
    equal(lockOf(profile).capabilities[id].trusted, true, `${id} trust is recorded in the lock`);
    executableSurfaces[id] = trust.result.executableSurface[id];
  }
  // oas.okf's surface is the one a reader is most likely to assume the package
  // covers, because the OKF protocol's own harvest step runs through it.
  assert(executableSurfaces["oas.okf"].commands.includes("harvest"),
    `oas.okf must expose the harvest command: ${JSON.stringify(executableSurfaces["oas.okf"])}`);
  return "oas.okf and oas.aweb approved at their artifact integrity; oas.review needed no approval";
});

check("the README's trust posture names EVERY capability this run had to trust", () => {
  // The blocker this closes: the README said "there is nothing to trust", which
  // was true of oas.review and false of the workspace — while THIS probe was
  // already trusting two capabilities, one line above, and saying nothing about
  // the contradiction. The document is now checked against what the run
  // observed rather than against a reviewer's memory.
  const section = (heading) => {
    const lines = README_TEXT.split("\n");
    const start = lines.findIndex((line) => line.trim() === heading);
    assert(start !== -1, `README has no ${JSON.stringify(heading)} section`);
    const out = [];
    for (let i = start + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i += 1) out.push(lines[i]);
    return out.join("\n");
  };
  const trust = section("## Acquire or activate review independently");
  const gated = Object.entries(executableSurfaces)
    .filter(([, surface]) => surface.commands.length || surface.hooks.length)
    .map(([id]) => id);
  assert(gated.length >= 2, `this check is only meaningful if the run gated something: ${JSON.stringify(executableSurfaces)}`);
  for (const id of gated) {
    assert(trust.includes(`oas trust ${id}`),
      `the README's trust posture never tells a reader to run \`oas trust ${id}\`, but this run had to: ` +
      `${id} declares commands ${JSON.stringify(executableSurfaces[id].commands)} and hooks ${JSON.stringify(executableSurfaces[id].hooks)}`);
  }
  // …and it must still be truthful about the capability that needs nothing.
  assert(/no executable surface/i.test(trust), "the README must keep saying oas.review needs no approval");
  return `README documents \`oas trust\` for ${gated.join(" and ")}`;
});

// ───────────────────────────────────────────────── agent types and nesting
step("8. agent types and the nested framework-repository override");
check("`oas create` + a soul type resolves oas.review through the developers family", () => {
  mkdirSync(join(profile, "agents"), { recursive: true });
  const created = oas(["create", "devbot", "--local", "--description", "probe developer", "--work", "checkout", "--runtime", "pi"], { cwd: profile });
  equal(created.status, 0, `create failed: ${created.text}`);
  const soulFile = join(profile, "local-agents", "devbot", "soul", "soul.yaml");
  writeFileSync(soulFile, `${readFileSync(soulFile, "utf8").replace(/\n*$/, "\n")}type: developers\n`);
  const doctor = oas(["doctor", profile, "--soul", "devbot"]).text;
  assert(/oas\.review\s+\[type:developers @/.test(doctor),
    `doctor must resolve oas.review through the developers agent type:\n${doctor.split("\n").filter((l) => l.includes("oas.review")).join("\n")}`);
  assert(/## Review discipline: oas\.review/.test(doctor), "the composed AGENTS.md must carry the oas.review injection");
  assert(/<!-- oas:capability:oas\.review src=.*installed\/oas\.review\/injects\/review\.md -->/.test(doctor),
    "the injection must be sourced from the MATERIALIZED artifact");
  // Non-vacuity: the OTHER additive entry targets framework-authors and
  // package-maintainers, so a developers soul must NOT resolve it.
  assert(!/oas\.authoring\s+\[type:developers/.test(doctor), "oas.authoring must not resolve for the developers family");
  return "developers → oas.review (and not oas.authoring)";
});

check("the framework-repository child config overrides only inside oas/", () => {
  // The exact fixture the parity suite uses, so the kernel-free parity claim and
  // the live resolution cannot drift apart.
  const child = join(profile, "oas");
  mkdirSync(join(child, "injects"), { recursive: true });
  cpSync(join(REPO, "test", "fixtures", "framework-child-oas-config.yaml"), join(child, "oas-config.yaml"));
  writeFileSync(join(child, "injects", "framework-workspace.md"), "## framework workspace\n");

  const inside = oasJson(["doctor", child]);
  deepEqual(inside.chain.map((c) => c.file), [join(child, "oas-config.yaml"), join(profile, "oas-config.yaml")],
    "the child config is the closest scope, the adopted profile the outer one");
  equal(inside.layers.knowledge.integration, "oas.okf", "the child inherits the knowledge layer");
  equal(inside.layers.messaging.integration, "oas.aweb", "the child inherits the messaging layer");
  assert(!inside.layers.tasks.integration, "the child inherits tasks none");
  // The injection's SOURCE is prefixed with the name of the scope that supplied
  // it, so this is the live evidence for the child fixture's distinct scope name
  // (PARITY.md, delta 5): `oas-framework-repo` is the oas/ scope, not the root.
  deepEqual(inside.injects.map((i) => i.source), ["oas-framework-repo:framework"],
    "the framework injection resolves INSIDE oas/, and names the CHILD scope that supplied it");
  equal(inside.injects[0].file, join(child, "injects", "framework-workspace.md"), "and resolves to the child's own file");
  // …while TEAM identity is inherited from the root profile untouched. The child
  // declares no `team:` block, so a rename here would be a policy change wearing
  // a scope-name costume.
  equal(inside.team.name, "oas-framework", "team identity inside oas/ is the root profile's, unchanged");

  const outside = oasJson(["doctor", profile]);
  deepEqual(outside.injects, [], "the framework injection must NOT reach the workspace root");
  return "inherited layers, framework injection scoped to oas/ only";
});

// ─────────────────────────────────────────── known released-0.20 kernel defects
step("9. known released-0.20 kernel defects (recorded, never worked around)");
check("the doctor orphan warning is a KERNEL defect, not a missing lock entry", () => {
  const lock = lockOf(profile);
  for (const id of EXPECTED_CAPABILITIES) assert(lock.capabilities[id], `the lock MUST carry ${id} — that part is ours`);
  const lines = oas(["doctor", profile]).text.split("\n").map((l) => l.trim());
  const orphans = lines.filter((l) => l.includes("is in installed/ but has no lock entry"));
  if (orphans.length) {
    defect("released 0.20.0 `oas doctor` false orphan warning (kernel defect — no package workaround)",
      `every capability IS locked:\n${EXPECTED_CAPABILITIES.map((id) => `  ${id} ← ${lock.capabilities[id].package}`).join("\n")}\n` +
      `warnings emitted verbatim:\n${orphans.map((l) => `  ${l}`).join("\n")}`);
  }
  const unexpected = lines.filter((l) => l.startsWith("WARNING") && !l.includes("has no lock entry"));
  deepEqual(unexpected, [], "no doctor warning other than the known kernel defect");
  return `${orphans.length} false-orphan warnings recorded; no other warning`;
});

check("the config-key diagnostic garbles inherited names — kernel defect, recorded", () => {
  const bad = newScope("bad-config");
  writeFileSync(join(bad, "oas-config.yaml"), "name: demo\nconstructor: anything\n");
  const run = oas(["doctor", bad], { expect: "fail" });
  assert(/constructor/.test(run.text), `the kernel must reject the unsupported key:\n${run.text.slice(0, 400)}`);
  // The THROWN message, not the source line node echoes above the stack: both
  // contain the phrase, and only the thrown one carries the garbled value.
  const line = (run.text.split("\n").find((l) => l.trimStart().startsWith("Error: unsupported oas-config key")) || "").trim();
  if (/function Object\(\)/.test(run.text)) {
    defect("released 0.20.0 config-key error resolves through Object.prototype (kernel defect — no package workaround)",
      `a rejected key named "constructor" is reported with an inherited value:\n${line}`);
  }
  return line ? line.slice(0, 120) : "rejected";
});

// ────────────────────────────────────────────────────────── cutover diagnosis
step("10. cutover: a v1 lock is refused, never silently converted");
check("acquisition into a v1-locked scope fails with legacy-lock and mutates nothing", () => {
  const v1 = newScope("v1-scope");
  const lockFile = join(v1, "oas-lock.json");
  const v1Doc = {
    lockfileVersion: 1,
    capabilities: {
      "oas.okf": {
        source: "marketplace:oas.okf", version: "1.4.1",
        integrity: `sha256-${"0".repeat(64)}`, trustedExecutables: true,
      },
    },
  };
  writeFileSync(lockFile, JSON.stringify(v1Doc, null, 2) + "\n");
  const before = readFileSync(lockFile, "utf8");
  const refused = oasJson(["install", "oas.dev", "--dir", v1, "--no-requirements"], { expect: "fail" });
  equal(refused.ok, false, "acquisition must fail");
  equal(refused.error.code, "legacy-lock", "refusal code");
  assert(/lockfileVersion 1/.test(refused.error.message) && /oas migrate/.test(refused.error.message),
    `the refusal must name the version and the remedy: ${refused.error.message}`);
  equal(readFileSync(lockFile, "utf8"), before, "the v1 lock must not be converted, repaired or rewritten");
  assert(!existsSync(join(v1, ".agents", "capabilities", "installed")), "nothing may be materialized into a scope that was refused");
  return `${refused.error.code}: ${refused.error.message.split(" — ")[0].split("/").pop()}`;
});

// ───────────────────────────────────────────────────────── spawn composition
step("11. spawn composition (scaffold only) and retire");
// The aweb spawn hook is REQUIRED and mints an identity through `aw`, so the
// scope needs an aweb root for the hook to find. It is a directory in the
// sandbox: no real workspace, team or credential is ever touched.
mkdirSync(join(profile, ".aw"), { recursive: true });
let ownerHome = null;
let reviewerHome = null;

check("a profile instance scaffolds with the layer capabilities composed", () => {
  const spawned = oasJson(["spawn", "devbot", "--purpose", "probe", "--task", "probe task", "--no-launch"], { cwd: profile });
  assert(spawned.ok, `spawn failed: ${JSON.stringify(spawned.error)}`);
  equal(spawned.result.launched, false, "--no-launch must scaffold only");
  ownerHome = spawned.result.home;
  const meta = readJson(join(ownerHome, "instance.json"));
  deepEqual((meta.capabilities || []).map((c) => c.id).sort(), ["oas.aweb", "oas.okf", "oas.review"],
    "a developers-typed soul composes both layers plus the type-targeted oas.review");
  equal(meta.capabilityMeta["oas.aweb"].team, TEAM, "the aweb hook recorded the minted team");
  equal(meta.capabilityMeta["oas.aweb"].alias, "devbot-probe", "the aweb alias is the instance name");
  return `${spawned.result.instance}: launched:false, capabilities ${(meta.capabilities || []).map((c) => c.id).join(", ")}`;
});

check("the reviewer is available from oas.review as a CAPABILITY-DEFINED agent", () => {
  // No `oas create reviewer` anywhere: the soul lives read-only inside the
  // materialized oas.review artifact, and the kernel resolves it because the
  // adopted profile declares the capability.
  assert(!existsSync(join(profile, "local-agents", "reviewer", "soul")), "the reviewer soul must not be a local soul in the scope");
  deepEqual(CAPABILITY_MANIFEST.agents, ["agents/reviewer"], "the manifest declares the reviewer soul");
  const spawned = oasJson(["spawn", "reviewer", "--purpose", "abc1234", "--task", "Review commit abc1234",
    "--work", "attached", "--work-dir", join(ownerHome, "work"), "--parent", "devbot-probe", "--no-launch"], { cwd: profile });
  assert(spawned.ok, `reviewer spawn failed: ${JSON.stringify(spawned.error)}`);
  assert(/capability agent: "reviewer" from oas\.review/.test(spawned._text),
    `the kernel must resolve the reviewer as a capability agent:\n${spawned._text}`);
  equal(spawned.result.launched, false, "--no-launch must scaffold only");
  equal(spawned.result.work, "attached", "the capability soul's declared work mode");
  equal(spawned.result.parent, "devbot-probe", "attached instances are children of the work-tree owner");
  reviewerHome = spawned.result.home;

  const meta = readJson(join(reviewerHome, "instance.json"));
  equal(meta.kind, "capability", "instance.json records the capability-defined origin");
  deepEqual((meta.capabilities || []).map((c) => c.id).sort(), ["oas.aweb", "oas.okf"],
    "the ephemeral reviewer composes the two layer capabilities");
  for (const entry of meta.capabilities) {
    equal(entry.trusted, true, `${entry.id} must be trusted in the instance record`);
    assert(entry.skills.every((s) => s.includes(`installed${"/"}${entry.id}/`)), `${entry.id} skills must resolve inside its materialized artifact`);
  }
  deepEqual(meta.layers.knowledge.split(" ")[0], "oas.okf", "instance knowledge layer");
  deepEqual(meta.layers.messaging.split(" ")[0], "oas.aweb", "instance messaging layer");
  assert(/^none\b/.test(meta.layers.tasks), `instance tasks layer must be none, got ${meta.layers.tasks}`);
  // A capability-defined agent always carries its OWN capability's skills, even
  // though the reviewer soul is typeless and oas.review targets families.
  const reviewSkills = meta.skills.filter((s) => s.source === "oas.review").map((s) => s.name).sort();
  deepEqual(reviewSkills, ["code-review", "security-review"], "the reviewer carries oas.review's own skills");
  return `${spawned.result.instance}: capability agent, ${meta.skills.length} skills, launched:false`;
});

check("retire tears the instance down cleanly and the aweb identity self-deletes", () => {
  const retired = oasJson(["retire", "reviewer-abc1234", "--force"], { cwd: profile });
  equal(retired.retired, "reviewer-abc1234", `retire did not run: ${JSON.stringify(retired)}`);
  equal(retired.removedDir, true, "the instance home is removed");
  assert(!existsSync(reviewerHome), "the instance home is gone from disk");
  deepEqual(retired.capabilityMeta["oas.aweb"], { retired: true }, "the aweb retire hook reports a completed self-delete");
  const calls = readFileSync(AW_LOG, "utf8");
  assert(calls.includes("team join probe-invite-token --name reviewer-abc1234"), `the spawn hook joined the team as the instance:\n${calls}`);
  assert(calls.includes("workspace delete reviewer-abc1234"), `retire must self-delete the aweb workspace:\n${calls}`);
  return "instance home removed, aweb workspace deleted";
});

check("`--no-launch` started NO tmux session and executed no runtime", () => {
  const tmuxCalls = existsSync(TMUX_LOG) ? readFileSync(TMUX_LOG, "utf8").split("\n").filter(Boolean) : [];
  const creating = tmuxCalls.filter((l) => /^(new-session|new-window|split-window|send-keys|respawn-)/.test(l));
  deepEqual(creating, [], `--no-launch must never create a tmux session or window:\n${tmuxCalls.join("\n")}`);
  const piCalls = existsSync(PI_LOG) ? readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean) : [];
  const launching = piCalls.filter((l) => !/^(list|--list-models)\b/.test(l));
  deepEqual(launching, [], `the runtime stub must only have been PROBED, never launched:\n${piCalls.join("\n")}`);
  return `tmux: ${tmuxCalls.length} query/teardown call(s), 0 sessions; pi: ${piCalls.length} probe call(s), 0 launches`;
});

check("no real credential store, deployment or checkout was read or written", () => {
  assert(!existsSync(join(HOME, ".aw")), "the probe HOME must stay free of aweb state");
  for (const stray of ["oas-lock.json", "oas-config.yaml", ".agents"]) {
    assert(!existsSync(join(REPO, stray)), `the probe must not have written ${stray} into the repository`);
  }
  const dirty = git(REPO, ["status", "--porcelain", "--", "oas-package"]);
  equal(dirty, "", `the payload under test must be untouched by the probe:\n${dirty}`);
  return "HOME clean, repository payload untouched";
});

check("no stub was invoked in a way the probe did not plan for", () => {
  // Last on purpose: every unplanned call since the baseline landed here.
  const seen = existsSync(UNEXPECTED) ? readFileSync(UNEXPECTED, "utf8").trim() : "";
  equal(seen, "", `unexpected stub invocations:\n${seen}`);
  return "sentinel empty";
});

// ──────────────────────────────────────────────────────────────────── report
const passed = results.filter((r) => r.ok).length;
if (defects.length) {
  process.stdout.write(`\nKNOWN RELEASED-0.20 KERNEL DEFECTS (recorded verbatim, worked around NOWHERE):\n${defects.join("\n")}\n`);
}
process.stdout.write(`\nconsumer probe against @oas-framework/oas@${KERNEL_VERSION}: ${passed}/${results.length} checks passed\n`);
if (failures) {
  process.stderr.write(`consumer probe FAILED — ${failures} check(s)\n`);
  process.exit(1);
}
succeeded = true;
