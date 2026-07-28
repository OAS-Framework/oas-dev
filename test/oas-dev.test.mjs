import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../oas-package", import.meta.url)));
const CAPABILITY = join(ROOT, "capabilities", "oas-review");
const read = (...parts) => readFileSync(join(CAPABILITY, ...parts), "utf8");

test("reviewer soul is an ephemeral attached capability agent", () => {
  const soul = read("agents", "reviewer", "soul.yaml");
  assert.match(soul, /^name: reviewer$/m);
  assert.match(soul, /^kind: capability$/m);
  assert.match(soul, /^work: attached$/m);
  assert.match(soul, /^runtime: pi$/m);
  assert.match(soul, /^model: .+$/m);
});

test("reviewer operating loop requires both packaged review skills", () => {
  const instructions = read("agents", "reviewer", "AGENTS.md");
  assert.match(instructions, /code-review/);
  assert.match(instructions, /security-review/);
  assert.match(instructions, /Verdict first: `APPROVE`, `APPROVE WITH NITS`, or `NEEDS CHANGES`/);
  // Delivery is messaging-layer-agnostic: report to the spawner over whatever
  // messaging layer is active, with a transcript fallback when none is.
  assert.match(instructions, /Deliver the report \*\*to your spawner\*\*/);
  assert.match(instructions, /parentInstance/);
  assert.match(instructions, /If a messaging layer is active/);
  assert.doesNotMatch(instructions, /aw mail|aweb/);
  assert.match(instructions, /oas retire <your-instance> --self/);
  assert.match(instructions, /Never edit the work tree/);
});

test("packaged skill names match their directories", () => {
  for (const name of ["code-review", "security-review"]) {
    const skill = read("skills", name, "SKILL.md");
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(skill, /description:/);
  }
});

test("developer injection preserves paired harvest and reviewer discipline", () => {
  const injection = read("injects", "review.md");
  assert.match(injection, /After every substantive commit, launch the reviewer/);
  // Knowledge promotion is a layer-agnostic placeholder, not a named command.
  assert.match(injection, /<your knowledge layer's promotion command>/);
  assert.doesNotMatch(injection, /aw mail|aweb/);
  assert.match(injection, /oas spawn reviewer --work attached/);
  assert.match(injection, /Multi-developer features/);
});
