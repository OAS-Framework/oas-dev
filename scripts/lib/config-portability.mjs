/**
 * ONE predicate for "may this config template be copied into somebody else's
 * repository?", shared by the manifest validator (scripts/validate-manifests.mjs)
 * and the consumer probe (scripts/consumer-probe.mjs) so the two cannot drift.
 *
 * A `configTemplates` entry is package SOURCE MATERIAL, never installed
 * behavior: `oas install` applies none of it, and `oas init --package` copies it
 * VERBATIM — bytes, comments and all — into the adopter's repository, where it
 * is committed as their own local policy. Anything our deployment owns (a
 * credential, an account, a machine path) becomes a leak in a foreign repo the
 * moment the template is adopted.
 *
 * WHY STRUCTURAL, NOT A DENY-LIST OF DIRECTORIES. Enumerating known path roots
 * ("/Users", "/opt/acme") was tried and lost: /tmp, Windows drive letters, UNC
 * shares and tilde-home forms all sailed through. The rule here is structural
 * instead — a scalar that IS, or EMBEDS, an absolute or home-relative path, in
 * any spelling a host might produce, is non-portable regardless of which
 * directory it names.
 *
 * TWO SURFACES, DELIBERATELY DIFFERENT STRICTNESS:
 *
 *   VALUES   (parsed by the kernel's own reader — see ./kernel-yaml.mjs) get the
 *            full token scan: what a value says is configuration, and an
 *            absolute path in one is a live setting pointing at our machine.
 *   COMMENTS get a narrow identity scan. They are PROSE: an illustrative
 *            "/etc/oas" in a sentence is documentation, and running the value
 *            rules over prose would reject the portable URL
 *            https://docs.example.test/home/getting-started. Only a person or
 *            machine IDENTITY, and a credential assignment, leak here.
 *
 * Comments are scanned at all because the kernel ignores them completely and
 * they still land in the adopter's repository word for word. The kernel's
 * supported subset is a FLOOR for this policy, not its definition.
 */
import { extractComments, parseKernelYaml } from "./kernel-yaml.mjs";

/** A URL with a scheme is a portable reference — except `file:`, which is a
 * machine path wearing a scheme. Handled separately and FIRST, because `file:`
 * is legal with one slash (`file:/etc/x`) as well as three. */
const FILE_SCHEME = /^file:/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Host environment references, wherever they appear inside a value. */
const HOST_ENV = /\$\{?(HOME|USER|PWD)\b|%(USERPROFILE|HOMEPATH|USERNAME)%/i;

/** A key that NAMES a secret. */
export const CREDENTIAL_KEY = /(^|[_-])(tokens?|secrets?|passwo?rds?|api[_-]?keys?|credentials?)($|[_-])/i;

/** A secret being ASSIGNED, in free text: `api_key: sk-…`, `--api-key=sk-…`,
 * `token=…`. Key-name checking alone misses both a credential smuggled inside
 * an argument string and one sitting in a comment, and a template's comments are
 * copied to the adopter as faithfully as its values. */
export const CREDENTIAL_ASSIGNMENT = /(^|[^\w])-{0,2}(tokens?|secrets?|passwo?rds?|api[_-]?keys?|credentials?)\s*[:=]/i;

/** A COMPLETE URL span anywhere inside a scalar. Used to remove portable
 * references before looking for local paths in what remains — the exemption
 * belongs to the URL itself, not to the whole scalar because a URL happened to
 * start it. `file:` spans are deliberately left in place: they ARE local paths. */
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
function withoutPortableUrls(text) {
  return String(text).replace(URL_SPAN, (span) => (FILE_SCHEME.test(span) ? span : " ".repeat(span.length)));
}

/** Delimiters that can separate a path from surrounding text. `:` is NOT one —
 * it belongs to a Windows drive letter — and `.` and `@` are not, so an
 * scp-style git remote stays one token. */
const TOKEN_SPLIT = /[\s"'`(){}\[\]<>,;|=&]+/;

/** An scp-style git remote: `user@host:path`. Its path is REMOTE — including
 * when it is absolute, `git@example.com:/srv/git/repo.git` — so no colon tail
 * may be taken from it. The `@` is what distinguishes it from `key:/local/path`. */
const SCP_REMOTE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/;

/** Why this scalar cannot travel to another machine, or undefined if it can. */
export function nonPortableValue(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (FILE_SCHEME.test(text)) return "a file: URI naming a local path";
  if (HOST_ENV.test(text)) return "a host environment path";
  if (URL_SCHEME.test(text)) return undefined;           // ordinary URL: portable
  if (/^~($|[/\\]|[A-Za-z0-9_.-]+)/.test(text)) return "a home-relative (~) path";
  if (/^[A-Za-z]:[\\/]/.test(text)) return "a Windows drive-letter path";
  if (/^\\\\[^\\]/.test(text)) return "a Windows UNC network path";
  if (/^\\(?!\\)/.test(text)) return "a Windows root-relative path";
  if (/^\//.test(text)) return "an absolute machine path";
  return undefined;
}

/** A token, plus what follows each of its colons. `key:/tmp/x` embeds a path
 * that no whitespace delimiter separates, so the colon has to be considered —
 * but it cannot simply be a TOKEN_SPLIT delimiter, because a Windows drive
 * letter needs its colon. A single-character prefix is therefore a drive and is
 * left alone, and `file:` is a scheme nonPortableValue already classifies. A
 * provider team id like `default:oas-framework.example` yields a clean tail and
 * stays legal. */
function* pathCandidates(token) {
  yield token;
  if (SCP_REMOTE.test(token)) return;
  for (let i = token.indexOf(":"); i !== -1; i = token.indexOf(":", i + 1)) {
    const prefix = token.slice(0, i);
    if (prefix.length > 1 && !/^file$/i.test(prefix)) yield token.slice(i + 1);
  }
}

/** Why a local path appearing ANYWHERE in this scalar cannot travel.
 *
 * Deliberately no second set of "embedded" patterns: maintaining path forms
 * twice is how the two drift, and they did — embedded matchers that required a
 * trailing slash and a boundary character let `--home=~alice`, `--home=~`,
 * `cd /` and `paths=[/etc/oas/x]` through while the very same strings were
 * rejected as whole values. Instead the text is split into tokens and each is
 * handed to nonPortableValue, so there is exactly ONE definition of every path
 * form and a new embedding context cannot silently escape it. */
export function localPathIn(value) {
  for (const token of withoutPortableUrls(value).split(TOKEN_SPLIT)) {
    if (!token) continue;
    for (const candidate of pathCandidates(token)) {
      const reason = nonPortableValue(candidate);
      if (reason) return reason;
    }
  }
  return undefined;
}

/** Markers that identify a PERSON or MACHINE. Applied ONLY to comment text —
 * see the header for why comments are held to a narrower rule than values. */
export const IDENTIFYING_MARKERS = [
  [/\/(Users|home)\/[^\s/"']+/, "a user home directory"],
  [/[A-Za-z]:\\Users\\[^\s\\"']+/i, "a Windows user profile directory"],
  [/(^|[\s"'(=])~\//m, "a home-relative (~) path"],
  [/\$\{?HOME\b|%USERPROFILE%/i, "a host home reference"],
  // A plausible URI path must follow the scheme, or ordinary prose trips it:
  // "edit this file: before use" is not a file URI.
  [/file:(\/\/|\/|[A-Za-z]:)/i, "a file: URI"],
];

const ADOPTED_VERBATIM = "templates are adopted verbatim into other people's deployments";

/**
 * Leaks in the PARSED values of a template.
 * @param {unknown} parsed what ./kernel-yaml.mjs returned for the template
 * @returns {string[]} human-readable reasons; empty means portable
 */
export function valueLeaks(parsed) {
  const leaks = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (node && typeof node === "object") {
      // OWN properties only, and never a bare `in`/index dispatch: `__proto__`
      // is refused outright by the parser, and enumerating own entries is what
      // keeps this walk seeing exactly what the kernel will read.
      for (const [key, item] of Object.entries(node)) {
        if (key === "__proto__") {
          leaks.push(`"${[...path, key].join(".")}" uses the "__proto__" key, which hides settings from every validator that enumerates own keys`);
          continue;
        }
        if (CREDENTIAL_KEY.test(key)) {
          leaks.push(`"${[...path, key].join(".")}" is a credential-shaped setting; ${ADOPTED_VERBATIM}`);
        }
        walk(item, [...path, key]);
      }
      return;
    }
    const where = path.join(".") || "(root)";
    const reason = nonPortableValue(node);
    if (reason) {
      leaks.push(`"${where}" is ${reason} (${JSON.stringify(node)}); ${ADOPTED_VERBATIM}`);
    } else if (typeof node === "string") {
      // nonPortableValue only classifies a value that IS a path. One EMBEDDED in
      // a larger scalar identifies its author just as well, so the string is
      // tokenized — after complete non-file URL spans are removed — and every
      // token goes through the SAME classifier. Removing URLs by SPAN rather
      // than exempting the whole scalar is what makes
      //   "https://example.test/guide --config=/Users/alice/private.yaml"
      // fail while "open https://example.test/Users/guide" passes.
      const embedded = localPathIn(node);
      if (embedded) leaks.push(`"${where}" embeds ${embedded} (${JSON.stringify(node)}); ${ADOPTED_VERBATIM}`);
    }
    if (typeof node === "string" && CREDENTIAL_ASSIGNMENT.test(node)) {
      leaks.push(`"${where}" assigns a credential-shaped value; ${ADOPTED_VERBATIM}`);
    }
  };
  walk(parsed, []);
  return leaks;
}

/**
 * Leaks in the COMMENT text of a template.
 * @param {string} comments what ./kernel-yaml.mjs extractComments returned
 * @returns {string[]}
 */
export function commentLeaks(comments) {
  const leaks = [];
  const text = String(comments ?? "");
  for (const [pattern, what] of IDENTIFYING_MARKERS) {
    if (pattern.test(text)) {
      leaks.push(`a comment mentions ${what}; comments are adopted verbatim into other people's deployments`);
      break;
    }
  }
  if (CREDENTIAL_ASSIGNMENT.test(text)) {
    leaks.push("a comment assigns a credential-shaped value; comments are adopted verbatim into other people's deployments");
  }
  return leaks;
}

/**
 * The whole predicate over a template's SOURCE TEXT: parse it the way the kernel
 * will, then scan values and comments.
 *
 * @param {string} source the template's bytes
 * @returns {string[]} reasons the template is not portable; empty means portable
 * @throws {Error} when the source uses YAML the OAS config reader would silently
 *   drop or reinterpret — the caller must report that separately, because a
 *   template we cannot read as the kernel does is not a template we may bless.
 */
export function portabilityLeaks(source) {
  const parsed = parseKernelYaml(source);
  return [...commentLeaks(extractComments(source)), ...valueLeaks(parsed)];
}
