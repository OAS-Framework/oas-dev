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
  ]) {
    assert.ok(CREDENTIAL_KEY.test(key), `MUST be flagged: ${key}`);
  }
  for (const key of ["tokenizer", "passport", "keyring", "api_version", "description", "team"]) {
    assert.equal(CREDENTIAL_KEY.test(key), false, `MUST NOT be flagged: ${key}`);
  }
});

test("CREDENTIAL_ASSIGNMENT matches an assignment, not the WORD", () => {
  for (const text of [
    "api_key: sk-live-leaked", "--api-key=sk-live-leaked", "token=abc123",
    "password:hunter2", "passwd=hunter2", "# secret: shh",
  ]) {
    assert.ok(CREDENTIAL_ASSIGNMENT.test(text), `MUST be flagged: ${text}`);
  }
  for (const text of [
    "no credential, account, or machine path may ship here",
    "the operator adds any auth to the local snapshot",
    "tokenizer: simple",
  ]) {
    assert.equal(CREDENTIAL_ASSIGNMENT.test(text), false, `MUST NOT be flagged: ${text}`);
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
