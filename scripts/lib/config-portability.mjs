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
 *            machine IDENTITY, and a credential assignment, leak here — and the
 *            identity half removes complete non-file URL spans first, the same
 *            way the value half does, so that promise about /home/ URLs holds
 *            in the code and not only in this comment.
 *
 *            TWO RULES ARE EXEMPT FROM THAT BLANKING, both because a URL is a
 *            fine place to hide what they look for: the credential assignment
 *            (`https://host/x?token=sk-live`) and the host environment
 *            reference (`https://x/a$HOME/y`). Neither is a path shape, so the
 *            reason the exemption exists does not reach them.
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

/** Host environment references, wherever they appear — inside a value, and
 * inside a comment, including within a URL span (see commentLeaks). */
const HOST_ENV = /\$\{?(HOME|USER|PWD)\b|%(USERPROFILE|HOMEPATH|USERNAME)%/i;

/** The nouns that NAME a secret. `passw[or]{0,2}ds?` rather than `passwo?rds?`:
 * the unix spelling `passwd` is at least as likely in a settings key as
 * `password`, and an adversarial fixture found it missing. A deny heuristic
 * that only covers the long form is the one that ships a secret. */
const BUDGET_NOUN = "tokens";
const CREDENTIAL_NOUN = `${BUDGET_NOUN}|token|secrets?|passw[or]{0,2}ds?|api[_-]?keys?|credentials?`;
/** Every noun EXCEPT the plural `tokens`, which is the only one a head
 * qualifier may exempt — see NON_SECRET_HEAD below. The singular `token` stays
 * here, so `output_token` is flagged while `output_tokens` is not. */
const UNQUALIFIABLE_NOUN = "token|secrets?|passw[or]{0,2}ds?|api[_-]?keys?|credentials?";

/**
 * QUALIFIERS THAT MAKE A CREDENTIAL NOUN A MEASUREMENT OR A SWITCH.
 *
 * The noun list above is the right thing to look for and the wrong thing to
 * stop at: `max_tokens` is a model's context budget, `token_limit` is a rate
 * limit, `secret-scanning` turns a scanner on. None of them is a secret, and a
 * template that legitimately configures any of them could not be shipped —
 * which is how a portability gate teaches people to work around it.
 *
 * So the noun is read in context, by two guards with DIFFERENT reach. Stating
 * that difference exactly is the point of this comment: an earlier version said
 * a head word "means the key names something ABOUT credentials rather than a
 * credential", full stop, and the code applied it to every noun — so
 * `input_secret`, `output_token`, `total_secret` and `max_password` were all
 * silently accepted. A deny heuristic that exempts `input_secret` is not a deny
 * heuristic.
 *
 * TAIL — applies to EVERY noun. A trailing qualifier describes what is done
 * with credentials: `token_limit`, `secret_scanning`, `password_policy`,
 * `api_key_rotation`, `credentials_required`. The word sits AFTER the noun, so
 * it cannot be part of a secret's own name, and the reading is the same
 * whichever noun precedes it.
 *
 * HEAD — applies to the PLURAL `tokens` and to nothing else. The head list is
 * model-budget vocabulary, and that vocabulary counts things, so it is plural
 * without exception: `max_tokens`, `input_tokens`, `output_tokens`,
 * `prompt_tokens`, `completion_tokens`, `cached_tokens`, `total_tokens`,
 * `num_tokens`. There is no corresponding reading for any other noun — an
 * `input_secret` is a secret that comes in, an `output_token` is a token that
 * goes out, and a `max_password` is nothing at all. Restricting the head to the
 * one noun it was justified by is the narrowest rule that keeps the budget
 * vocabulary shippable, and it is why the singular `output_token` is flagged
 * while the plural `output_tokens` is not.
 *
 * Both lists are closed and short on purpose. `token_value`, `secret_key`,
 * `api_key_2` and every bare spelling stay flagged, because none of them
 * matches either guard.
 */
const NON_SECRET_HEAD = "max|min|total|input|output|prompt|completion|cached|estimated|average|avg|num|number";
const NON_SECRET_TAIL = "budgets?|limits?|counts?|usage|polic(?:y|ies)|scanning|scanner|rotation|ttl|expiry|required|enabled|disabled";

/**
 * A key that names a secret VALUE. Boundaries are lookarounds rather than
 * consumed separators so the head/tail guards can inspect what sits either side
 * of the noun without the match position moving.
 *
 * The head guard sits INSIDE the alternation, on the budget branch alone, so
 * `max_tokens` is exempt and `max_password` is not. The singular `token` lives
 * in the other branch and carries no head exemption; on `max_tokens` that
 * branch matches the first five characters and then dies on the trailing
 * word-boundary lookahead, which is what keeps the plural exempt.
 */
export const CREDENTIAL_KEY = new RegExp(
  "(?<=^|[_-])" +                                        // key-word boundary before
  "(?:" +
    `(?<!(?:^|[_-])(?:${NON_SECRET_HEAD})[_-])${BUDGET_NOUN}` +   // `max_tokens` exempt
    `|(?:${UNQUALIFIABLE_NOUN})` +                        // every other noun: no head exemption
  ")" +
  "(?=$|[_-])" +                                         // key-word boundary after
  `(?![_-](?:${NON_SECRET_TAIL})(?:$|[_-]))`,            // …not `_limit`, `_scanning`, …
  "i",
);

/** A secret being ASSIGNED, in free text: `api_key: sk-…`, `--api-key=sk-…`,
 * `token=…`. Key-name checking alone misses both a credential smuggled inside
 * an argument string and one sitting in a comment, and a template's comments are
 * copied to the adopter as faithfully as its values.
 *
 * The same head guard applies — and the same restriction to the plural `tokens`
 * — widened to a SPACE separator because this rule reads prose: `# max tokens:
 * 4096` is a documented setting, not a leaked one, while `--max-password=hunter2`
 * is a leaked one and used to be exempt for exactly the reason corrected above.
 * No tail guard is needed — the assignment operator has to follow the noun
 * immediately, so `token budget: 500` never matched in the first place.
 *
 * THE NOUN MAY BE GLUED TO A COMPOUND HEAD, and requiring a non-word character
 * in front of it is what let a family of plain secrets ship. The prefix was
 * `(?:^|[^\w])`, so every underscore- or hyphen-compounded name was exempt:
 * `--auth_token=sk-live-…`, `# my_api_key=sk-live-…` and `# user_password=hunter2`
 * each carry a word character immediately before the noun and were all reported
 * clean — while the very same keys are flagged by CREDENTIAL_KEY, which reads
 * `_`/`-` as a word boundary. So an optional `\w+[_-]` head is allowed here too:
 * `<anything>_token=` is a token being assigned, whatever names it.
 *
 * The budget exemption is untouched by that widening, because it never depended
 * on the prefix — it is the same head LOOKBEHIND, which asks what sits before
 * the noun rather than what the match consumed. `input_tokens=4096`,
 * `max_tokens: 4096` and `# total tokens = 128000` stay clean: the budget branch
 * dies on the lookbehind, and the singular `token` branch then dies on the `s`
 * that stands between it and the assignment operator. `auth_token=sk-live` has
 * no such head, so nothing exempts it. */
export const CREDENTIAL_ASSIGNMENT = new RegExp(
  "(?:^|[^\\w])-{0,2}" +
  "(?:\\w+[_-])?" +                                      // …or glued to a compound head
  "(?:" +
    `(?<!(?:^|[^A-Za-z0-9])(?:${NON_SECRET_HEAD})[\\s_-])${BUDGET_NOUN}` +
    `|(?:${UNQUALIFIABLE_NOUN})` +
  ")" +
  "\\s*[:=]",
  "i",
);

/**
 * A COMPLETE URL span anywhere inside a scalar. Used to remove portable
 * references before looking for local paths in what remains — the exemption
 * belongs to the URL itself, not to the whole scalar because a URL happened to
 * start it. `file:` spans are deliberately left in place: they ARE local paths.
 *
 * WHERE THE SPAN ENDS IS THE WHOLE SECURITY PROPERTY, and it used to end only at
 * whitespace or a quote. Everything else was swallowed, so a machine path
 * written straight after a URL was laundered by the link in front of it:
 *
 *   https://example.test/x)/Users/alice      the `)` and the path, all "URL"
 *   https://example.test/docs,/Users/alice   likewise for `,`
 *   https://example.test/docs(/Users/alice   and for `(`
 *   https://example.test/a~/oas/notes.md     and for a tilde home path
 *
 * Each is a comment or value a reviewer reads as "a link, then my home
 * directory", and the scan read as "one long URL". So the span now ends at the
 * PROSE BOUNDARIES — whitespace, quotes, backtick, brackets, parentheses, comma,
 * semicolon, angle brackets, pipe, backslash, caret.
 *
 * WHAT IS DELIBERATELY NOT A BOUNDARY, in full, because a half-stated policy is
 * the one that grows a gap. Everything else printable stays INSIDE the span:
 * `= & ? # : @ ! * + % $ - . _ /` and a `~` not followed by `/`. Each is legal
 * URL syntax that a reader sees as part of the link — query (`?a=1&b=2`),
 * fragment (`#section`), userinfo and port (`user@host:8443`), percent-escapes
 * (`%7E`), and the sub-delims `! * + $`. Terminating at any of them would hand
 * the tail of an ordinary documentation link to the token scan, and a gate that
 * reports every parameterized URL is a gate people route around.
 *
 * PARITY WITH TOKEN_SPLIT, stated exactly rather than as "the same characters",
 * which it was called while it was not: every boundary above except `\` is also
 * a TOKEN_SPLIT separator, and TOKEN_SPLIT additionally separates on `=` and `&`
 * (it is splitting an already-blanked scalar, where query syntax no longer has a
 * URL to belong to). The backslash is the one asymmetry and it is required in
 * that direction: it must END a URL span, or `https://x/a\Users\me` launders a
 * Windows root-relative path, and it must NOT split a token, or `C:\Users\me`
 * and `\\server\share` fall apart into fragments no path form recognizes. The
 * caret used to be the SECOND asymmetry, in the unsound direction — a URL span
 * ended there and the token scan did not split there, so
 * `https://example.test/a^/Users/x` handed back the single token
 * `^/Users/x`, which classifies as nothing at all. TOKEN_SPLIT carries `^` now.
 *
 * The tilde is handled by lookahead rather than as a boundary character, because
 * `~` is legal in a URL path: the span stops before a `~/` SEQUENCE (the
 * home-path form) and carries an ordinary `~user` on. So
 * https://example.test/~alice/guide survives intact and
 * https://example.test/a~/oas/notes.md gives the residual text back to the
 * scanner. A URL that genuinely contains `~/` must be spelled `%7E/`.
 *
 * Terminating early can only ever hand MORE text to the classifiers, never
 * less, so the direction of any residual inaccuracy is a loud false report
 * rather than a laundered leak.
 */
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/(?:(?!~\/)[^\s"'`(),;<>{}[\]|\\^])*/gi;
function withoutPortableUrls(text) {
  return String(text).replace(URL_SPAN, (span) => (FILE_SCHEME.test(span) ? span : " ".repeat(span.length)));
}

/** Delimiters that can separate a path from surrounding text. `:` is NOT one —
 * it belongs to a Windows drive letter — and `.` and `@` are not, so an
 * scp-style git remote stays one token. `\` is not one either: it is INSIDE the
 * Windows path forms nonPortableValue classifies. See URL_SPAN above for the
 * exact parity between this set and the URL boundary set. */
const TOKEN_SPLIT = /[\s"'`(){}\[\]<>,;|=&^]+/;

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

/** Markers that identify a PERSON or MACHINE by the shape of a PATH. Applied
 * ONLY to comment text, and only after complete non-file URL spans have been
 * blanked — see the header for why comments are held to a narrower rule than
 * values, and commentLeaks for the one marker that is NOT blanked first.
 *
 * The host-environment reference that used to live here (`$HOME`,
 * `%USERPROFILE%`) has moved out to a raw-text test against HOST_ENV: it is not
 * a path shape and must not be exempted by a URL. */
export const IDENTIFYING_MARKERS = [
  [/\/(Users|home)\/[^\s/"']+/, "a user home directory"],
  [/[A-Za-z]:\\Users\\[^\s\\"']+/i, "a Windows user profile directory"],
  [/(^|[\s"'(=])~\//m, "a home-relative (~) path"],
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
  // COMPLETE URL SPANS ARE REMOVED FIRST, exactly as they are for values.
  //
  // The header promises that a portable reference such as
  // https://docs.example.test/home/getting-started survives the comment scan;
  // the identity markers did not honour that, because `/(Users|home)/…` matches
  // just as happily inside a URL PATH as inside a machine path. A documentation
  // link to a page under /home/ or /Users/ was therefore rejected — and the
  // narrower rule comments are supposed to get was, in that one respect, the
  // stricter one.
  //
  // `file:` spans are deliberately left in place by withoutPortableUrls: they
  // ARE local paths, and the file: marker below still has to see them.
  const identityText = withoutPortableUrls(text);
  // …WITH ONE EXCEPTION, TESTED FIRST AND AGAINST THE RAW TEXT: a host
  // environment reference. The URL exemption exists because a URL PATH that
  // spells `/home/` is somebody's documentation, not somebody's home directory.
  // `$HOME` is not a path shape at all — it is an expansion the adopter's shell
  // performs wherever it appears, so `https://x/a$HOME/y` names OUR machine
  // exactly as much as `/Users/alice` does, and blanking the URL first reported
  // it clean. valueLeaks has always caught that string, because
  // nonPortableValue tests HOST_ENV BEFORE the URL exemption; this is the
  // comment half saying the same thing. Aligning rather than documenting the
  // gap: a portable link has no business carrying an unexpanded `$HOME`,
  // `$USER` or `%USERPROFILE%`, so there is no false positive to trade away.
  if (HOST_ENV.test(text)) {
    leaks.push("a comment mentions a host environment reference; comments are adopted verbatim into other people's deployments");
  } else {
    for (const [pattern, what] of IDENTIFYING_MARKERS) {
      if (pattern.test(identityText)) {
        leaks.push(`a comment mentions ${what}; comments are adopted verbatim into other people's deployments`);
        break;
      }
    }
  }
  // NOT identityText: the credential scan runs over the ORIGINAL text, because a
  // URL is a perfectly good place to leak one (`https://host/x?token=sk-live`).
  // The URL exemption is about PATHS looking like machine paths, and extending
  // it here would trade a false positive for a missed secret.
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
