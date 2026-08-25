import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NORMALIZED_LOCK_PREFIXES,
  RELEASE_TAG,
  SPELLINGS_HEADING,
  acceptedSpellings,
  commandLines,
  installSourceProblems,
  installSources,
  pinnedRef,
  refusedSpellings,
} from "../scripts/lib/readme-install-sources.mjs";

/**
 * The README is the only artifact in this repository a consumer EXECUTES before
 * any gate can look at what they typed. This suite is the offline half of the
 * two-part check on it:
 *
 *   here            the spellings are extracted and held to the pinning rules —
 *                   no network, no kernel, runs in `npm test`;
 *   consumer probe  every extracted spelling is fed to the RELEASED kernel's own
 *                   `parsePackageSource`, which is the only authority on what it
 *                   accepts, and every spelling documented as REFUSED is proved
 *                   to be refused.
 *
 * Neither half is sufficient. Rules asserted here could describe a parser that
 * does not exist; the probe alone would bless a README that documents a
 * perfectly parseable `oas.dev` that installs LAST YEAR'S package.
 *
 * Every rule below carries an adversarial fixture that seeds the exact defect
 * and proves detection. A rule with no failing fixture is indistinguishable
 * from a rule that never fires.
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const README = readFileSync(join(REPO, "README.md"), "utf8");

/** A minimal README that PASSES, so each fixture below can break exactly one
 * thing and the failure it produces is attributable. */
const SOUND = [
  "# fixture",
  "",
  SPELLINGS_HEADING,
  "",
  "| Spelling | Parser rule it satisfies |",
  "| --- | --- |",
  "| `oas.dev@v2.0.0` | official catalog id with a selector |",
  "",
  "- `catalog:oas.dev@v2.0.0` — the lock's normalized spelling, refused as a source",
  "",
  "## Use",
  "",
  "```bash",
  "oas install oas.dev@v2.0.0 --dir /path/to/scope",
  "```",
  "",
].join("\n");

const problemsFor = (readme) => installSourceProblems(readme);
const matching = (readme, pattern) => problemsFor(readme).filter((p) => pattern.test(p));

test("the fixture baseline is sound, so every failure below is attributable", () => {
  assert.deepEqual(problemsFor(SOUND), []);
});

// ─────────────────────────────────────────────── the real README under the rules

test("this package's README documents only sound install spellings", () => {
  assert.deepEqual(installSourceProblems(README), []);
});

test("the README's accepted table names each spelling family a consumer may reach for", () => {
  const spellings = acceptedSpellings(README).map((row) => row.spelling);
  assert.ok(spellings.includes(`oas.dev@${RELEASE_TAG}`), "the official catalog id, pinned by selector");
  assert.ok(spellings.some((s) => s.startsWith("https://") && s.endsWith(RELEASE_TAG)), "a raw pinned Git URL");
  assert.ok(spellings.some((s) => s.startsWith("git:") && !s.startsWith("git:http")), "the git:host/org/repo shorthand");
  assert.ok(spellings.some((s) => s.includes("#")), "an explicit contained-package-root selection");
  assert.ok(spellings.some((s) => s.startsWith("path:")), "a local path, for contributors");
  // Every row explains WHY the kernel accepts it. A table of bare strings is a
  // list of incantations, and the next editor cannot tell a typo from a rule.
  for (const { spelling, rule } of acceptedSpellings(README)) {
    assert.ok(rule.length > 20, `spelling ${spelling} is documented without a parser rule`);
  }
});

test("the README names BOTH normalized lock spellings as refused", () => {
  const refused = refusedSpellings(README).map((row) => row.spelling);
  for (const [prefix] of NORMALIZED_LOCK_PREFIXES) {
    assert.ok(refused.some((s) => s.startsWith(prefix)), `no refusal documented for the ${prefix}… spelling a lock prints`);
  }
});

test("every runnable install command in the README pins this release", () => {
  const commands = installSources(README);
  assert.ok(commands.length >= 2, "the README must actually show install commands");
  for (const { source, command } of commands) {
    assert.equal(pinnedRef(source), RELEASE_TAG, `${JSON.stringify(command)} does not pin ${RELEASE_TAG}`);
  }
});

// ───────────────────────────────────────────────────────── adversarial fixtures

test("an UNPINNED catalog id is caught — it installs v1 from the released bundled catalog", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0", "oas install oas.dev");
  assert.equal(matching(readme, /unpinned/).length, 1, problemsFor(readme).join("\n"));
});

test("an unpinned Git URL is caught — it follows a branch head", () => {
  const readme = SOUND.replace("| `oas.dev@v2.0.0` |", "| `https://github.com/OAS-Framework/oas-dev.git` |");
  assert.equal(matching(readme, /unpinned/).length, 1, problemsFor(readme).join("\n"));
});

test("a spelling pinned to the WRONG tag is caught", () => {
  const readme = SOUND.replaceAll("oas.dev@v2.0.0", "oas.dev@v1.0.0");
  // Both the table row and the command carry the stale pin; both are reported.
  assert.equal(matching(readme, /pins "v1\.0\.0"/).length, 2, problemsFor(readme).join("\n"));
});

for (const [prefix] of NORMALIZED_LOCK_PREFIXES) {
  test(`a ${prefix}… lock spelling documented as a COMMAND is caught`, () => {
    const spec = prefix === "catalog:" ? "catalog:oas.dev@v2.0.0" : "git:https://github.com/OAS-Framework/oas-dev.git@v2.0.0";
    const readme = SOUND.replace("oas install oas.dev@v2.0.0", `oas install ${spec}`);
    assert.equal(matching(readme, /normalized/).length, 1, problemsFor(readme).join("\n"));
  });

  test(`a ${prefix}… lock spelling promoted into the ACCEPTED table is caught`, () => {
    const spec = prefix === "catalog:" ? "catalog:oas.dev@v2.0.0" : "git:https://github.com/OAS-Framework/oas-dev.git@v2.0.0";
    const readme = SOUND.replace("| `oas.dev@v2.0.0` |", `| \`${spec}\` |`);
    assert.ok(matching(readme, /normalized/).length >= 1, problemsFor(readme).join("\n"));
  });
}

test("dropping the refusal bullets is caught — an accepted table alone never warns about lock spellings", () => {
  const readme = SOUND.split("\n").filter((line) => !line.startsWith("- `catalog:")).join("\n");
  assert.equal(matching(readme, /names no REFUSED spelling/).length, 1, problemsFor(readme).join("\n"));
});

test("dropping the spelling table is caught", () => {
  const readme = SOUND.replace("| `oas.dev@v2.0.0` | official catalog id with a selector |", "");
  assert.equal(matching(readme, /no accepted-spelling table/).length, 1, problemsFor(readme).join("\n"));
});

test("a README with no runnable install command is caught", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0 --dir /path/to/scope", "echo nothing to see");
  assert.equal(matching(readme, /no runnable install command/).length, 1, problemsFor(readme).join("\n"));
});

test("a command whose meaning depends on the shell is REPORTED, never interpreted", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0 --dir /path/to/scope", "oas install oas.dev@$TAG --dir /path/to/scope");
  assert.equal(matching(readme, /depends on shell syntax/).length, 1, problemsFor(readme).join("\n"));
});

// ─────────────────────────────────────────────────────── extraction, both ways

test("bare `oas install --dir` is exact restore, not an undocumented source", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0 --dir /path/to/scope",
    "oas install oas.dev@v2.0.0 --dir /path/to/scope\noas install --dir /path/to/scope");
  assert.deepEqual(installSources(readme).map((s) => s.source), ["oas.dev@v2.0.0"]);
  assert.deepEqual(problemsFor(readme), []);
});

test("`oas use` and `oas doctor` arguments are not install sources", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0 --dir /path/to/scope",
    "oas install oas.dev@v2.0.0 --dir /path/to/scope\noas use oas.review --type developers\noas doctor /path/to/scope");
  assert.deepEqual(installSources(readme).map((s) => s.source), ["oas.dev@v2.0.0"]);
});

test("`oas init --package <source>` is an install source wherever the flag sits", () => {
  const readme = SOUND.replace("oas install oas.dev@v2.0.0 --dir /path/to/scope",
    "oas init --config default --package oas.dev@v2.0.0 --dir /path/to/scope");
  assert.deepEqual(installSources(readme).map((s) => s.source), ["oas.dev@v2.0.0"]);
});

test("only command-language fences are read as commands", () => {
  const yaml = ["```yaml", "oas install oas.dev", "```"].join("\n");
  assert.deepEqual(commandLines(`# f\n\n${yaml}\n`), []);
  const bash = ["```bash", "oas install oas.dev@v2.0.0 --dir /x", "```"].join("\n");
  assert.deepEqual(commandLines(`# f\n\n${bash}\n`).map((l) => l.text), ["oas install oas.dev@v2.0.0 --dir /x"]);
});

test("comment lines inside a fence are prose, and a `$` prompt is stripped", () => {
  const block = ["```bash", "# oas install oas.dev", "$ oas install oas.dev@v2.0.0 --dir /x", "```"].join("\n");
  assert.deepEqual(commandLines(block).map((l) => l.text), ["oas install oas.dev@v2.0.0 --dir /x"]);
});

test("pinnedRef mirrors the kernel's splitRef, fragment removed first", () => {
  assert.equal(pinnedRef("oas.dev@v2.0.0"), "v2.0.0");
  assert.equal(pinnedRef("https://github.com/OAS-Framework/oas-dev.git@v2.0.0"), "v2.0.0");
  assert.equal(pinnedRef("https://github.com/OAS-Framework/oas-dev.git@v2.0.0#oas-package"), "v2.0.0");
  assert.equal(pinnedRef("https://github.com/OAS-Framework/oas-dev.git"), undefined);
  // An `@` BEFORE the last `/` belongs to the host, not to a ref — the same
  // reason the kernel compares the two positions rather than just splitting.
  assert.equal(pinnedRef("git@github.com:OAS-Framework/oas-dev.git"), undefined);
});
