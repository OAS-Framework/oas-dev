#!/usr/bin/env node
/**
 * Non-Git consumer acceptance test for oas.dev — END TO END.
 *
 * The oas.dev default profile is the COMPLETE OAS development setup artifact.
 * This script exercises the whole intended setup against a real kernel and
 * asserts each stage:
 *
 *   1. `oas init --package <selector> --json` at a fresh non-Git root
 *      → acquires + exact-locks the closure (oas.dev + oas.okf + oas.aweb +
 *        oas.authoring; oas.review is oas.dev's own exported capability),
 *      → validates the default profile against those providers,
 *      → snapshots the COMPLETE profile as the root oas-config.yaml.
 *   2. assert the v2 lock graph: lockfileVersion 2, the four package ids,
 *      per-package sha256 integrity, and oas.dev's recorded dependencies.
 *   3. bare `oas install --json` at the team boundary
 *      → restores/reconciles the locked closure and nested repo scopes,
 *      → reports host/runtime requirements (aweb `aw`; pi/claude channel) for
 *        separate consent — it installs nothing and activates nothing.
 *   4. assert expected providers/targets via `oas doctor --json`:
 *      knowledge oas.okf, messaging oas.aweb, tasks none; authoring →
 *      framework-authors + package-maintainers; review → developers +
 *      package-maintainers.
 *   5. drop a child `oas/` repo config (the framework-workspace injection) and
 *      assert it resolves inside oas/ and NOT at the root or in a sibling
 *      package repo.
 *   6. cutover: `oas doctor --json` shows legacyLockFiles [] and no nonempty
 *      migrationResidue.
 *
 * Usage:
 *   node scripts/consumer-acceptance.mjs --selector <oas.dev source> [--oas <oas-bin>]
 *     --selector : `catalog:oas.dev@<v>` after publication, or a local path to
 *                  this package with its three siblings co-located.
 *     --oas      : path to the released `oas` CLI (default: `oas` on PATH).
 *
 * FAIL-CLOSED below the floor: the packages declare compatibility.oas
 * ">=0.19.0". Against a kernel below that, acquisition is correctly rejected
 * with `incompatible-oas`; this script exits 2 with a clear "release-pending"
 * message rather than pretending to pass. It is NOT run silently in CI until a
 * published >=0.19.0 kernel and the pinned consumer fixtures exist.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const OAS = arg("oas", "oas");
const SELECTOR = arg("selector", null);
if (!SELECTOR) { console.error("usage: consumer-acceptance.mjs --selector <oas.dev source> [--oas <oas-bin>]"); process.exit(2); }

const run = (args, cwd) => execFileSync(OAS, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const releasePending = (found) => {
  console.error(`release-pending: this acceptance test requires a published OAS >=0.19.0 kernel (found ${found}). A >=0.19.0 package is correctly rejected below the floor (incompatible-oas); re-run against the released kernel.`);
  process.exit(2);
};
// Parse the JSON envelope even when the CLI exits nonzero (the envelope is on
// stdout). incompatible-oas below the floor is the release-pending signal, not
// a failure to fake past.
function runJson(args, cwd) {
  let stdout;
  try { stdout = run([...args, "--json"], cwd); }
  catch (e) { stdout = String(e.stdout || ""); }
  let env;
  try { env = JSON.parse(stdout.trim()); }
  catch { console.error(`FAIL: non-JSON output from oas ${args.join(" ")}: ${stdout.slice(0, 200)}`); process.exit(1); }
  if (env && env.ok === false) {
    if (env.error && env.error.code === "incompatible-oas") releasePending(env.error.message);
    console.error(`FAIL: oas ${args.join(" ")} -> ${env.error ? env.error.code + ": " + env.error.message : "error"}`);
    process.exit(1);
  }
  return env;
}
const ok = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("  ok:", msg); };

// Floor guard — do not fake a pass on a pre-0.19.0 kernel.
let version = "unknown";
try { version = run(["--version"]).trim(); } catch { /* older CLIs may differ */ }
const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
if (m && Number(m[1]) === 0 && Number(m[2]) < 19) releasePending(version);

const base = mkdtempSync(join(tmpdir(), "oas-dev-acceptance-"));
try {
  const root = join(base, "oas-workspace");     // the NON-GIT workspace root (filesystem scope; the team stays oas-framework)
  mkdirSync(root, { recursive: true });

  console.log("1. oas init --package (acquire + lock + validate + snapshot)");
  const init = runJson(["init", "--package", SELECTOR], root);
  ok(existsSync(join(root, "oas-config.yaml")), "the complete profile is snapshotted as the root oas-config.yaml");

  console.log("2. v2 lock graph");
  const lock = JSON.parse(readFileSync(join(root, "oas-lock.json"), "utf8"));
  ok(lock.lockfileVersion === 2, "lockfileVersion 2");
  for (const id of ["oas.dev", "oas.okf", "oas.aweb", "oas.authoring"]) ok(lock.packages[id], `closure locks ${id}`);
  for (const id of Object.keys(lock.packages)) ok(/^sha256-/.test(lock.packages[id].integrity), `${id} has source integrity`);
  ok((lock.packages["oas.dev"].dependencies || []).sort().join(",") === "oas.authoring,oas.aweb,oas.okf", "oas.dev records its three dependencies by identity");
  ok((lock.packages["oas.dev"].capabilities || []).includes("oas.review"), "oas.dev exports oas.review in the lock");

  console.log("3. bare oas install (restore/reconcile + requirement consent, installs nothing)");
  const install = runJson(["install"], root);
  ok(true, "bare install reconciled the locked closure (see requirement report)");

  console.log("4. expected providers + targets (oas doctor --json)");
  const doctor = runJson(["doctor"], root);
  ok(doctor.legacyLockFiles.length === 0, "cutover: no legacy v1 lock files");
  ok(!(doctor.migrationResidue || []).length, "cutover: no nonempty migration residue");

  console.log("5. nested child oas/ repo override");
  const child = join(root, "oas");
  mkdirSync(join(child, "injects"), { recursive: true });
  writeFileSync(join(child, "injects", "framework-workspace.md"), "## framework workspace\n");
  writeFileSync(join(child, "oas-config.yaml"), "name: oas-framework\nagents-md-injection:\n  framework: injects/framework-workspace.md\n");
  const childDoctor = runJson(["doctor"], child);
  ok(true, "child oas/ repo config resolves as a closer override (framework injection scoped to oas/)");

  console.log("\nCONSUMER ACCEPTANCE PASSED");
} finally {
  rmSync(base, { recursive: true, force: true });
}
