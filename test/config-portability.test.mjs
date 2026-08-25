import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_ASSIGNMENT,
  CREDENTIAL_KEY,
  commentLeaks,
  localPathIn,
  nonPortableValue,
  portabilityLeaks,
  valueLeaks,
} from "../scripts/lib/config-portability.mjs";

/**
 * UNIT fixtures for the shared portability predicate
 * (scripts/lib/config-portability.mjs), the one definition of "may this config
 * template be copied into somebody else's repository?" that both the manifest
 * gate and the consumer probe call.
 *
 * The manifest suite proves the predicate is WIRED IN — end to end, through the
 * real validator. This suite proves the predicate itself is RIGHT, one path
 * class at a time and in BOTH directions, because the two failure modes are
 * symmetric and equally fatal:
 *
 *   too narrow → our machine's paths and secrets ship to an adopter;
 *   too broad  → the only template that passes the gate is one that documents
 *                nothing and references nothing.
 *
 * Enumerating known roots (/Users, /home, …) is what lost the first time —
 * /tmp, every Windows spelling and tilde-home all sailed through — so the
 * table below is organized by STRUCTURAL CLASS, and every class carries its own
 * accept control. A class with no accept control is a rule nobody can tell from
 * "reject everything".
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * [class, reject samples, accept controls]. Each reject sample is checked as a
 * WHOLE value and EMBEDDED in a longer scalar; each accept control the same
 * way. One definition of every path form, exercised through both entry points.
 */
const PATH_CLASSES = [
  ["a POSIX absolute path",
    ["/etc/oas/instructions.md", "/Users/someone/skills/review", "/"],
    ["etc/oas/instructions.md", "./etc/oas/instructions.md", ".agents/injections/oas.md"]],
  ["an absolute path under /tmp",
    ["/tmp/local-machine/instructions.md", "/tmp"],
    ["tmp/local-machine/instructions.md", "var-tmp/instructions.md"]],
  ["a home-relative tilde path",
    ["~/machine-local/instructions.md", "~"],
    ["backup~", "injects/review~1.md"]],
  ["a tilde-USER path",
    ["~someone/instructions.md", "~someone"],
    ["review~someone.md", "a~b"]],
  ["a $HOME-style host environment reference",
    ["$HOME/instructions.md", "${HOME}/instructions.md", "$USER/instructions.md", "$PWD/instructions.md"],
    ["$HOMEBREW_PREFIX/bin", "$USERS_GUIDE", "$OAS_INSTANCE_HOME_DIR"]],
  ["a %USERPROFILE%-style host environment reference",
    ["%USERPROFILE%\\instructions.md", "%USERNAME%", "%HOMEPATH%\\x"],
    ["USERPROFILE/instructions.md", "%OAS_SCOPE%"]],
  ["a Windows drive-letter path with BACKSLASHES",
    ["C:\\Users\\local\\instructions.md", "d:\\work"],
    ["c:relative", "note:value"]],
  // NOTE the accept controls here carry no absolute tail: a MULTI-character
  // prefix before ":/" is not a drive letter, so `cc:/x` is read as an embedded
  // absolute path (the `config:/tmp/x` rule) and is rejected on purpose. Only a
  // single-character prefix is treated as a drive and left intact.
  ["a Windows drive-letter path with FORWARD slashes",
    ["C:/Users/local/instructions.md", "d:/work"],
    ["cc:relative-not-a-drive", "default:oas-framework.example"]],
  ["a Windows UNC network path",
    ["\\\\server\\share\\instructions.md", "\\\\server"],
    ["server\\share\\instructions.md", "a\\\\b"]],
  ["a Windows ROOT-RELATIVE backslash path",
    ["\\rooted\\instructions.md", "\\"],
    ["rooted\\instructions.md", "a\\b"]],
  ["a file: URI",
    ["file:///Users/me/instructions.md", "file:/etc/oas/instructions.md", "file:///C:/Users/me/x.md"],
    ["https://oas.dev/docs/file", "notfile://example.test/x", "profile.md"]],
];

for (const [label, rejected, accepted] of PATH_CLASSES) {
  test(`nonPortableValue REJECTS ${label}`, () => {
    for (const value of rejected) {
      assert.ok(nonPortableValue(value), `MUST be rejected but was accepted: ${JSON.stringify(value)}`);
    }
  });

  test(`nonPortableValue ACCEPTS the ${label} controls`, () => {
    for (const value of accepted) {
      assert.equal(nonPortableValue(value), undefined,
        `MUST be accepted but was rejected as ${nonPortableValue(value)}: ${JSON.stringify(value)}`);
    }
  });

  test(`localPathIn REJECTS ${label} EMBEDDED in a larger scalar`, () => {
    // A path embedded in an argument string identifies its author just as well
    // as one that is the whole value, and there is exactly ONE definition of
    // each form: the embedded scan tokenizes and calls nonPortableValue.
    for (const value of rejected) {
      for (const carrier of [`launch --config=${value}`, `see ${value} for details`, `paths=[${value}]`]) {
        assert.ok(localPathIn(carrier), `MUST be rejected but was accepted: ${JSON.stringify(carrier)}`);
      }
    }
  });

  test(`localPathIn ACCEPTS the ${label} controls embedded in a larger scalar`, () => {
    for (const value of accepted) {
      for (const carrier of [`launch --config=${value}`, `see ${value} for details`]) {
        assert.equal(localPathIn(carrier), undefined,
          `MUST be accepted but was rejected as ${localPathIn(carrier)}: ${JSON.stringify(carrier)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// URLs: portable by SPAN, not by prefix.
// ---------------------------------------------------------------------------

test("a complete URL span is exempt wherever it sits, and exempts only ITSELF", () => {
  // The exemption belongs to the URL, not to the whole scalar because a URL
  // happened to start it — otherwise one leading link launders everything after.
  for (const portable of [
    "https://oas.dev/docs/config",
    "open https://example.test/Users/guide",
    "see https://example.test/home/x and https://example.test/Users/y",
    "clone git@github.com:OAS-Framework/oas-dev.git",
    "git@example.com:/srv/git/repo.git",
  ]) {
    assert.equal(localPathIn(portable), undefined, `${portable} is portable: ${localPathIn(portable)}`);
  }
  assert.ok(localPathIn("https://example.test/guide --config=/Users/alice/private.yaml"),
    "a leading URL must not launder the machine path that follows it");
  // `file:` wears a scheme but IS a local path, so its span is deliberately not
  // removed before the scan.
  assert.ok(localPathIn("read file:/etc/oas/instructions.md first"));
});

test("an scp-style git remote keeps its colon tail, even when the remote path is absolute", () => {
  // `user@host:/srv/…` is REMOTE. Taking a colon tail from it would reject every
  // git remote a template legitimately names.
  assert.equal(nonPortableValue("git@example.com:/srv/git/repo.git"), undefined);
  assert.equal(localPathIn("git@example.com:/srv/git/repo.git"), undefined);
  // But a non-scp colon really does hide a path, and that one must be caught.
  assert.ok(localPathIn("launch config:/tmp/private.yaml"));
  assert.ok(localPathIn("launch {config:/tmp/private.yaml}"));
});

// ---------------------------------------------------------------------------
// Credentials: named keys, and assignments in free text.
// ---------------------------------------------------------------------------

test("CREDENTIAL_KEY matches secret-NAMING keys and nothing that merely resembles one", () => {
  for (const key of [
    "token", "tokens", "secret", "secrets", "password", "passwd", "api_key",
    "api-key", "apikey", "credentials", "auth_token", "client-secret", "api_keys",
    // The tightening below must not open any of these: none carries a
    // non-secret qualifier, so each still names a secret VALUE.
    "token_value", "secret_key", "api_key_2", "refresh-token", "service_password",
  ]) {
    assert.ok(CREDENTIAL_KEY.test(key), `MUST be flagged: ${key}`);
  }
  for (const key of ["tokenizer", "passport", "keyring", "api_version", "description", "team"]) {
    assert.equal(CREDENTIAL_KEY.test(key), false, `MUST NOT be flagged: ${key}`);
  }
});

test("CREDENTIAL_KEY accepts settings that MEASURE or SWITCH credentials", () => {
  // The reported over-flagging. A credential noun with a measurement head
  // (`max_tokens` — a model's context budget) or a qualifier tail
  // (`token_limit`, `secret-scanning`) names something ABOUT credentials, never
  // a credential, and a template that legitimately configures one could not
  // ship. That is how a portability gate teaches people to route around it.
  for (const key of [
    "max_tokens", "max-tokens", "min_tokens", "input_tokens", "output_tokens",
    "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens",
    "num_tokens", "number_tokens",
    "token_budget", "token_limit", "tokens_limit", "token-count", "token_usage",
    "secret_scanning", "secret-scanner", "password_policy", "password-policies",
    "api_key_rotation", "credentials_required", "token_ttl", "secret_expiry",
    "credential_enabled", "credentials-disabled",
  ]) {
    assert.equal(CREDENTIAL_KEY.test(key), false, `MUST NOT be flagged: ${key}`);
  }
});

test("a measurement HEAD exempts the budget noun only, never every credential noun", () => {
  // The over-exemption this closes. The head guard was applied to every noun in
  // the list, so a whole family of plainly-secret keys shipped: a head word was
  // taken to mean "this key is ABOUT credentials" whatever noun followed it.
  //
  // The head list is model-budget vocabulary, and that vocabulary COUNTS, so it
  // is plural without exception. `input_secret` is a secret that comes in;
  // `output_token` is a token that goes out; `max_password` is nothing at all.
  for (const key of [
    "input_secret", "output_token", "total_secret", "max_password",
    "min_credentials", "prompt_api_key", "num_passwd", "cached_secret",
    "completion-token", "average_password", "estimated_credentials",
    // The singular/plural line, stated as a fixture rather than left implicit.
    "output_token", "max_token",
  ]) {
    assert.ok(CREDENTIAL_KEY.test(key), `MUST be flagged: ${key}`);
  }
  // The other direction, immediately beside it: the budget vocabulary the head
  // list exists for is untouched, and it is untouched for EVERY head.
  for (const key of [
    "max_tokens", "min_tokens", "total_tokens", "input_tokens", "output_tokens",
    "prompt_tokens", "completion_tokens", "cached_tokens", "estimated_tokens",
    "average_tokens", "avg_tokens", "num_tokens", "number_tokens",
  ]) {
    assert.equal(CREDENTIAL_KEY.test(key), false, `MUST NOT be flagged: ${key}`);
  }
});

test("CREDENTIAL_ASSIGNMENT matches an assignment, not the WORD", () => {
  for (const text of [
    "api_key: sk-live-leaked", "--api-key=sk-live-leaked", "token=abc123",
    "password:hunter2", "passwd=hunter2", "# secret: shh",
    // A credential inside a URL is still a credential: the comment scan
    // deliberately does NOT strip URL spans before this rule.
    "see https://example.test/callback?token=sk-live-leaked",
  ]) {
    assert.ok(CREDENTIAL_ASSIGNMENT.test(text), `MUST be flagged: ${text}`);
  }
  for (const text of [
    "no credential, account, or machine path may ship here",
    "the operator adds any auth to the local snapshot",
    "tokenizer: simple",
    // The same over-flagging, in prose. A documented model setting is not a
    // leaked secret, and a template's comments are where such settings get
    // explained.
    "# max tokens: 4096",
    "# total tokens = 128000",
    "# token budget: 500",
  ]) {
    assert.equal(CREDENTIAL_ASSIGNMENT.test(text), false, `MUST NOT be flagged: ${text}`);
  }
  // Non-vacuity for the head guard: the qualifier has to be a WORD of its own,
  // so a noun that merely ends in one is untouched.
  assert.ok(CREDENTIAL_ASSIGNMENT.test("climax tokens: sk-live-leaked"),
    "only a standalone measurement word may exempt an assignment");
  // …and it may exempt only the budget noun. `--max-password=hunter2` was
  // accepted while `# max tokens: 4096` was the thing the guard existed for.
  for (const text of ["--max-password=hunter2", "# total secret: shh", "# output token = sk-live"]) {
    assert.ok(CREDENTIAL_ASSIGNMENT.test(text),
      `a measurement head must not exempt a non-budget noun: ${text}`);
  }
});

test("valueLeaks finds a credential key at any depth, and leaves portable settings alone", () => {
  assert.deepEqual(valueLeaks({ name: "x", capabilities: { additive: { "x.y": { settings: { theme: "dark" } } } } }), []);
  const leaks = valueLeaks({ capabilities: { additive: { "x.y": { settings: { api_key: "sk-live" } } } } });
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /capabilities\.additive\.x\.y\.settings\.api_key/);
  assert.match(leaks[0], /credential-shaped setting/);
});

test("valueLeaks reports the PATH to a non-portable value, so the fix is obvious", () => {
  const leaks = valueLeaks({ "agents-md-injection": { framework: "/Users/someone/injects/x.md" } });
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /"agents-md-injection\.framework" is an absolute machine path/);
});

test("valueLeaks refuses a __proto__ key rather than walking past it", () => {
  const carrier = JSON.parse('{"__proto__": {"home": "/Users/someone"}}');
  const leaks = valueLeaks(carrier);
  assert.ok(leaks.some((leak) => leak.includes("__proto__")), leaks.join(" | "));
});

test("valueLeaks walks arrays as well as maps", () => {
  // The kernel's flow form `[a, b]` is a legal config list, so a path can hide
  // in an element rather than in a scalar value.
  assert.ok(valueLeaks({ paths: ["injects/a.md", "/Users/someone/b.md"] }).length);
  assert.deepEqual(valueLeaks({ paths: ["injects/a.md", "injects/b.md"] }), []);
});

// ---------------------------------------------------------------------------
// Comments: a NARROWER rule, deliberately. They are prose, and they still land
// in the adopter's repository word for word.
// ---------------------------------------------------------------------------

test("commentLeaks flags an identity or a credential in prose", () => {
  for (const [label, comment] of [
    ["a POSIX user home", "# see /Users/someone/notes.md"],
    ["a Linux user home", "# see /home/someone/notes.md"],
    ["a Windows user profile", "# see C:\\Users\\someone\\notes.md"],
    ["a tilde path", "# copy it to ~/oas/notes.md"],
    ["a $HOME reference", "# copy it to $HOME/oas"],
    ["a %USERPROFILE% reference", "# copy it to %USERPROFILE%\\oas"],
    ["a file: URI", "# read file:/etc/oas/notes.md"],
    ["a credential assignment", "# api_key: sk-live-leaked"],
  ]) {
    assert.ok(commentLeaks(comment).length, `MUST be flagged — ${label}: ${comment}`);
  }
});

test("commentLeaks leaves documentation alone", () => {
  // A template that cannot describe itself is a template nobody adopts. These
  // are exactly the shapes the shipped profile's own comments use.
  for (const [label, comment] of [
    ["an illustrative placeholder", "# adopt this into /path/to/your/workspace"],
    ["an absolute path naming no person", "# the kernel reads /etc/oas defaults"],
    ["the portability promise", "# no credential, account, host path, or machine state"],
    ["prose containing 'file:'", "# edit this file: before use"],
    ["a documentation URL", "# see https://oas.dev/docs/config"],
    ["an inline command", "# run `oas init --package oas.dev`"],
  ]) {
    assert.deepEqual(commentLeaks(comment), [], `MUST NOT be flagged — ${label}: ${comment}`);
  }
});

test("commentLeaks exempts a portable URL whose PATH spells a home directory", () => {
  // The header has always promised this — "running the value rules over prose
  // would reject the portable URL https://docs.example.test/home/getting-started"
  // — while the identity markers matched /home/ and /Users/ inside a URL path
  // just as happily as in a machine path. Removing complete non-file URL spans
  // first, exactly as the value half does, is what makes the promise true.
  for (const [label, comment] of [
    ["an https URL under /Users/", "# see https://example.com/Users/guide"],
    ["an https URL under /home/", "# see https://docs.example.test/home/getting-started"],
    ["two of them in one sentence", "# see https://example.test/home/a and https://example.test/Users/b"],
    ["a URL beside ordinary prose", "# the guide at https://example.test/Users/guide explains the layout"],
  ]) {
    assert.deepEqual(commentLeaks(comment), [], `MUST NOT be flagged — ${label}: ${comment}`);
  }
});

test("commentLeaks still catches a real machine path beside a URL", () => {
  // The other direction, and the reason the exemption is by SPAN rather than by
  // "this comment contains a URL": one leading link must not launder the
  // machine path that follows it.
  for (const [label, comment] of [
    ["a home path after a URL", "# see https://example.test/docs then /Users/someone/notes.md"],
    ["a home path before a URL", "# copy /home/someone/notes.md, see https://example.test/docs"],
    ["a tilde path beside a URL", "# https://example.test/Users/guide describes ~/oas/notes.md"],
    ["a file: URI beside a URL", "# https://example.test/docs mirrors file:///Users/me/notes.md"],
  ]) {
    assert.ok(commentLeaks(comment).length, `MUST be flagged — ${label}: ${comment}`);
  }
});

test("a machine path ADJACENT to a URL is not laundered by it", () => {
  // The bypass this closes. The URL span used to run to the next whitespace or
  // quote and nothing else, so any punctuation a reader sees as ending the link
  // was swallowed along with everything after it — and a reviewer reading "a
  // link, then my home directory" got a scan that read "one long URL".
  //
  // No separating space in any of these: that is the point.
  for (const [label, comment] of [
    ["a closing paren ending the link", "# see https://example.test/x)/Users/alice/notes.md"],
    ["a comma ending the link", "# see https://example.test/docs,/Users/alice/notes.md"],
    ["an opening paren ending the link", "# see https://example.test/docs(/Users/alice/notes.md"],
    ["a tilde home path glued to the link", "# see https://example.test/a~/oas/notes.md"],
  ]) {
    assert.ok(commentLeaks(comment).length, `MUST be flagged — ${label}: ${comment}`);
  }
  // The same laundering worked on VALUES, which share withoutPortableUrls.
  assert.ok(localPathIn("https://example.test/x)/Users/alice/private.yaml"),
    "the value half must see the path after the link too");
});

test("…and the URL exemption itself still holds, punctuation and tildes included", () => {
  // Non-vacuity for the tightening above: terminating a span EARLY can only hand
  // more text to the classifiers, so the failure mode it risks is a false report
  // on a perfectly portable link. Each of these is one.
  for (const [label, comment] of [
    // The original accept case: a URL whose PATH spells /Users/.
    ["a URL whose path spells /Users/", "# see https://example.com/Users/guide"],
    ["a URL whose path spells /home/", "# see https://docs.example.test/home/getting-started"],
    ["a ~user URL, where the tilde is NOT a home path", "# see https://example.test/~alice/Users/guide"],
    // `=` and `&` are query syntax and must never end a span, or every
    // parameterized documentation link becomes a finding.
    ["a query string", "# see https://example.test/search?q=a&section=/Users/x"],
    ["a fragment", "# see https://example.test/guide#/Users/section"],
  ]) {
    assert.deepEqual(commentLeaks(comment), [], `MUST NOT be flagged — ${label}: ${comment}`);
  }
});

test("the two surfaces really do have different strictness", () => {
  // Stated as an executable fact rather than a header claim: the SAME text is a
  // leak as a value and documentation as a comment. That asymmetry is the whole
  // design, and a future "simplification" that unifies them fails here.
  const illustrative = "/etc/oas/defaults.yaml";
  assert.ok(nonPortableValue(illustrative), "as a VALUE it points at a machine");
  assert.deepEqual(commentLeaks(`# the kernel reads ${illustrative}`), [], "as PROSE it identifies nobody");
});

// ---------------------------------------------------------------------------
// The whole predicate, over the template this package actually ships.
// ---------------------------------------------------------------------------

test("the SHIPPED config template is portable", () => {
  const source = readFileSync(
    join(REPO, "oas-package", "config-templates", "default", "oas-config.yaml"), "utf8");
  assert.deepEqual(portabilityLeaks(source), []);
});

test("portabilityLeaks reports value and comment leaks together", () => {
  const source = [
    "# see /Users/someone/notes.md",
    "name: fixture",
    'agents-md-injection: "/Users/someone/injects/x.md"',
    "api_key: sk-live-leaked",
    "",
  ].join("\n");
  const leaks = portabilityLeaks(source);
  assert.ok(leaks.some((leak) => leak.includes("user home directory")), leaks.join(" | "));
  assert.ok(leaks.some((leak) => leak.includes("absolute machine path")), leaks.join(" | "));
  assert.ok(leaks.some((leak) => leak.includes("credential-shaped setting")), leaks.join(" | "));
});

test("portabilityLeaks THROWS on YAML the kernel would silently misread", () => {
  // Not a leak but a refusal: a template we cannot read the way the kernel does
  // is not a template we may bless as portable.
  assert.throws(() => portabilityLeaks("name: fixture\nagent-types:\n  - developer\n"),
    /block sequences are dropped/);
});
