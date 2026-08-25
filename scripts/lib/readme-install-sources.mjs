/**
 * ONE reader for "which package sources does the README put in front of a
 * consumer?", shared by the offline suite (test/readme-install-sources.test.mjs)
 * and the consumer probe (scripts/consumer-probe.mjs) so the two cannot drift.
 *
 * WHY THIS EXISTS. A README is the only part of a package a consumer runs
 * before anything can check them: no schema, no lock and nothing in `npm test`
 * sees a command a human copies out of prose. And package sources have a
 * grammar the kernel enforces (`parsePackageSource`, engine contract §1) with
 * two traps documentation walks into every time:
 *
 *  1. THE LOCK'S SPELLING IS NOT AN INPUT SPELLING. A lock records
 *     `catalog:oas.dev@v2.0.0` and `git:https://…git@v2.0.0`. Both are REFUSED
 *     as sources — `catalog:` is not in the catalog-id alphabet, and the `git:`
 *     shorthand takes `host/org/repo`, never a URL. Copying what the lock
 *     prints is the most natural documentation mistake available here.
 *  2. AN UNPINNED CATALOG ID IS NOT THIS RELEASE. `oas.dev` resolves through
 *     whatever ref the consumer's catalog holds, and the released 0.20.0
 *     kernel's bundled catalog still names v1.0.0. Only the `@v2.0.0`
 *     selector, which overrides the catalog entry's ref, installs this package.
 *
 * So the spellings are EXTRACTED from the README text and then checked twice:
 * offline against the pinning rules below, and in the probe against the
 * released kernel's own parser — the only authority on what it accepts.
 *
 * THREE SURFACES, because the README documents sources in three shapes and a
 * checker that saw only one would bless the other two:
 *
 *   installSources()      runnable commands inside fenced blocks
 *   acceptedSpellings()   the "Install spellings" table — one row per spelling,
 *                         each with the parser rule it satisfies
 *   refusedSpellings()    the bullets naming spellings the kernel REJECTS
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: no shell parsing. A documented command
 * that needs quoting, expansion or substitution to be understood is REPORTED by
 * `unshellyProblems`, never interpreted — the same reasoning as
 * scripts/check-test-scripts.mjs, where trying to understand assembled shell
 * text lost four times. A command a reader has to think about is bad
 * documentation anyway.
 */

/** Fenced blocks whose contents are commands a reader is expected to type. */
const COMMAND_LANGUAGES = new Set(["", "bash", "sh", "shell", "console", "zsh"]);

/** Shell syntax that would make a documented line mean something other than the
 * words it shows. Any of these in a command line is a documentation defect. */
const SHELL_METACHARACTERS = /[`$&|;<>(){}*?!\\"']|\[|\]/;

/** The README heading that owns the spelling table and the refusal bullets. */
export const SPELLINGS_HEADING = "## Install spellings the released kernel accepts";

/** This release's immutable tag. A documented source that carries a ref or a
 * catalog selector must carry exactly this one: a floating ref documents
 * whatever the branch happens to be, and an unpinned catalog id documents
 * whatever ref the consumer's catalog holds (v1.0.0, on the released 0.20.0
 * kernel's bundled catalog). */
export const RELEASE_TAG = "v2.0.0";

/** The lock's NORMALIZED spellings: outputs of the parser, never inputs. */
export const NORMALIZED_LOCK_PREFIXES = [
  ["catalog:", 'the lock\'s normalized catalog spelling — a source is the bare id ("oas.dev@v2.0.0"); ":" is outside the catalog-id alphabet, so the kernel refuses it as invalid-source'],
  ["git:http", 'the lock\'s normalized Git spelling — the "git:" source shorthand takes host/org/repo, never a URL; document the raw URL, or "git:github.com/org/repo@ref"'],
];

/** Local-path spellings pin a working tree rather than a release, so the
 * pinning rules below do not apply to them. */
export const isLocalPathSpelling = (source) =>
  source.startsWith("path:") || source.startsWith("./") || source.startsWith("../") || source.startsWith("/") || source.startsWith("~");

/** The ref (or catalog selector) a spelling pins, or undefined. Mirrors the
 * kernel's own `splitRef`: the last `@` that follows the last `/`, after any
 * `#<path>` fragment has been removed. */
export function pinnedRef(source) {
  const body = String(source).split("#")[0];
  const at = body.lastIndexOf("@");
  return at > 0 && at > body.lastIndexOf("/") ? body.slice(at + 1) : undefined;
}

/**
 * Command lines inside command-language fences, with their 1-based README line
 * numbers. Prompt markers are stripped; comment lines are not commands.
 * @param {string} readme README source text
 * @returns {{line: number, text: string}[]}
 */
export function commandLines(readme) {
  const out = [];
  let fence = null; // the opening fence's character, or null outside a block
  let language = "";
  String(readme).split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    const opener = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(trimmed);
    if (fence === null) {
      if (opener) { fence = opener[1][0]; language = opener[2].toLowerCase(); }
      return;
    }
    if (/^(`{3,}|~{3,})\s*$/.test(trimmed) && trimmed.startsWith(fence)) { fence = null; return; }
    if (!COMMAND_LANGUAGES.has(language)) return;
    // Comment BEFORE prompt: `$ ` is the only prompt marker stripped, because a
    // `#` prompt and a `#` comment are the same character and comments are what
    // a README block actually contains — stripping `# ` first turned every
    // comment line into a "command" whose prose then tripped the shell check.
    if (!trimmed || trimmed.startsWith("#")) return;
    const text = trimmed.replace(/^\$\s+/, "");
    if (!text) return;
    out.push({ line: index + 1, text });
  });
  return out;
}

/** Command lines whose meaning depends on the shell rather than on the words
 * shown. Reported, never interpreted.
 * @returns {string[]} problems; empty means every documented command is literal
 */
export function unshellyProblems(readme) {
  return commandLines(readme)
    .filter(({ text }) => SHELL_METACHARACTERS.test(text))
    .map(({ line, text }) =>
      `README line ${line} documents a command whose meaning depends on shell syntax: ${JSON.stringify(text)} — ` +
      "install commands are checked as literal text against the kernel's source grammar, and a line that needs " +
      "quoting or expansion to be understood cannot be checked at all. Simplify it.");
}

/**
 * Every package SOURCE the README hands to the kernel in a runnable command:
 * the argument of `oas install <source>` and of `oas init --package <source>`.
 *
 * A leading `-` means the token is a flag, so the command carries no source
 * (bare `oas install --dir …` is exact restore, not acquisition). Those are
 * skipped rather than reported — they are correct commands.
 *
 * @param {string} readme README source text
 * @returns {{source: string, line: number, command: string}[]} in document order
 */
export function installSources(readme) {
  const out = [];
  for (const { line, text } of commandLines(readme)) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== "oas") continue;
      const sub = words[i + 1];
      let source;
      if (sub === "install") source = words[i + 2];
      else if (sub === "init") { const at = words.indexOf("--package", i + 2); source = at === -1 ? undefined : words[at + 1]; }
      if (source && !source.startsWith("-")) out.push({ source, line, command: text });
    }
  }
  return out;
}

/** The lines of the section a heading owns, with their 1-based line numbers. */
function sectionLines(readme, heading) {
  const lines = String(readme).split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2} /.test(lines[i])) break;
    out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

/**
 * The spellings the README's table presents as ACCEPTED, each with the parser
 * rule it claims to satisfy. A row qualifies only when its first cell is a lone
 * inline-code span — which skips the header and the `| --- |` separator without
 * having to recognize them.
 *
 * @returns {{spelling: string, rule: string, line: number}[]}
 */
export function acceptedSpellings(readme, heading = SPELLINGS_HEADING) {
  const out = [];
  for (const { line, text } of sectionLines(readme, heading)) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length !== 2) continue;
    const code = /^`([^`]+)`$/.exec(cells[0]);
    if (!code) continue;
    out.push({ spelling: code[1], rule: cells[1], line });
  }
  return out;
}

/**
 * The spellings the README's bullets present as REFUSED — `- \`<spelling>\` — …`.
 * @returns {{spelling: string, reason: string, line: number}[]}
 */
export function refusedSpellings(readme, heading = SPELLINGS_HEADING) {
  const out = [];
  for (const { line, text } of sectionLines(readme, heading)) {
    const m = /^- `([^`]+)` — (.*)$/.exec(text.trim());
    if (m) out.push({ spelling: m[1], reason: m[2], line });
  }
  return out;
}

/**
 * Everything wrong with the sources a README documents, checked WITHOUT the
 * kernel so `npm test` covers it offline. The probe additionally proves each
 * accepted spelling parses under the released kernel and each refused spelling
 * does not.
 *
 * @param {string} readme README source text
 * @param {{tag?: string}} [options]
 * @returns {string[]} problems; empty means the README is sound
 */
export function installSourceProblems(readme, { tag = RELEASE_TAG } = {}) {
  const problems = [...unshellyProblems(readme)];
  const accepted = acceptedSpellings(readme);
  const refused = refusedSpellings(readme);
  const commands = installSources(readme);

  if (!accepted.length) problems.push(`the README has no accepted-spelling table under ${JSON.stringify(SPELLINGS_HEADING)} — the spellings a consumer may type are the one thing this package cannot leave undocumented`);
  if (!refused.length) problems.push(`the README names no REFUSED spelling under ${JSON.stringify(SPELLINGS_HEADING)} — the lock's normalized forms look like sources and are not, and a table of accepted spellings alone never says so`);
  if (!commands.length) problems.push("the README documents no runnable install command — a package whose README never shows how to acquire it is not documented");

  // Accepted spellings and runnable commands are held to the same pinning rule:
  // a consumer cannot tell which of the two they are copying.
  for (const { spelling, line } of accepted) problems.push(...pinningProblems(spelling, `README line ${line} (spelling table)`, tag));
  for (const { source, line, command } of commands) problems.push(...pinningProblems(source, `README line ${line} (${JSON.stringify(command)})`, tag));

  for (const { spelling, line } of refused) {
    if (!NORMALIZED_LOCK_PREFIXES.some(([prefix]) => spelling.startsWith(prefix))) {
      problems.push(`README line ${line} lists ${JSON.stringify(spelling)} as refused, but it is not one of the lock's normalized spellings ${JSON.stringify(NORMALIZED_LOCK_PREFIXES.map(([p]) => p))} — document why the kernel refuses it, or stop listing it`);
    }
  }
  for (const { spelling, line } of accepted) {
    const normalized = NORMALIZED_LOCK_PREFIXES.find(([prefix]) => spelling.startsWith(prefix));
    if (normalized) problems.push(`README line ${line} presents ${JSON.stringify(spelling)} as usable, but it is ${normalized[1]}`);
  }
  return problems;
}

/** Why one documented spelling is not pinned to this release. */
function pinningProblems(source, where, tag) {
  if (NORMALIZED_LOCK_PREFIXES.some(([prefix]) => source.startsWith(prefix))) {
    const [, why] = NORMALIZED_LOCK_PREFIXES.find(([prefix]) => source.startsWith(prefix));
    return [`${where} documents ${JSON.stringify(source)}, which is ${why}`];
  }
  if (isLocalPathSpelling(source)) return [];
  const ref = pinnedRef(source);
  if (!ref) {
    return [`${where} documents ${JSON.stringify(source)} unpinned — an unpinned catalog id resolves to whatever ref the consumer's catalog holds (the released 0.20.0 kernel's bundled catalog still names v1.0.0), and an unpinned Git URL resolves to a branch head. Document "${source}@${tag}".`];
  }
  if (ref !== tag) return [`${where} documents ${JSON.stringify(source)}, which pins ${JSON.stringify(ref)} rather than this release's immutable tag ${JSON.stringify(tag)}`];
  return [];
}
