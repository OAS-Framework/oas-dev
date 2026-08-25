/**
 * Minimal JSON-Schema evaluator covering exactly the keywords the vendored 0.20
 * schemas use, shared by the manifest gate (scripts/validate-manifests.mjs) and
 * the consumer probe (scripts/consumer-probe.mjs) so the two cannot drift.
 *
 * It is deliberately not a general implementation. The four schemas in
 * `schemas/` are byte-identical copies of the published kernel's `docs/`, and
 * this module's job is to say what THEY say — nothing more. Reaching for an
 * off-the-shelf validator would add a runtime dependency to a package that
 * asserts it has none, and a MORE capable evaluator is actively dangerous here
 * for the same reason a more capable YAML parser is (see ./kernel-yaml.mjs): it
 * would bless documents the kernel's own reader treats differently.
 *
 * SUPPORTED: $ref into `#/$defs/`, allOf, oneOf, const, enum, type, minLength,
 * pattern, not.pattern, minItems, uniqueItems, items (SINGLE subschema form),
 * required, properties, propertyNames.pattern, propertyNames.minLength,
 * additionalProperties (false or subschema).
 *
 * NOT SUPPORTED, and absent from all four vendored schemas: anyOf, if/then/else,
 * $ref outside $defs, numeric bounds, format, dependent schemas, and the
 * TUPLE form of `items` (`items: [A, B]`, which positionally constrains the
 * first elements). A schema that grows one of these silently gets weaker
 * validation, so `unsupportedKeywords` exists to make that visible at the call
 * site rather than at an adopter's install.
 *
 * SUPPORT IS POSITIONAL, WHICH IS WHY THE REPORT HAS TO BE TOO. A keyword this
 * evaluator implements at an ordinary schema position is not thereby implemented
 * everywhere it can legally appear: `not` is read for its `pattern` and nothing
 * else, and `propertyNames` was read for its `pattern` and nothing else. The
 * vendored lock schema's `propertyNames: { minLength: 1 }` was therefore a
 * silent gap that `unsupportedKeywords` reported as clean — `minLength` is a
 * supported keyword, so a flat name check saw nothing wrong, while the empty
 * property name the schema exists to refuse validated happily. Both halves are
 * fixed below: the walk is contextual, and `propertyNames.minLength` is now
 * actually applied.
 *
 * THREE MORE POSITIONS WERE SILENT, and each is closed by the cheaper of the two
 * available fixes — implement it, or report it — never by leaving it unsaid:
 *
 *   SIBLINGS OF `oneOf`   were DROPPED: the branch loop returned, so any
 *                         constraint beside the alternation was dead. This was
 *                         live in the vendored lock schema, whose ROOT carries
 *                         `type: "object"` and `required: ["lockfileVersion"]`
 *                         beside its two-branch `oneOf` — neither of which was
 *                         ever asserted, and neither of which could be REPORTED
 *                         as unsupported without failing the "the vendored
 *                         schemas are fully covered" check on a schema this
 *                         package may not edit. So they are IMPLEMENTED: the
 *                         alternation is one constraint among the node's others,
 *                         which is what JSON Schema says it is.
 *   SIBLINGS OF `$ref`    were dropped the same way, by the same early return.
 *                         Same fix, one line, and it is the 2020-12 reading:
 *                         `$ref` no longer replaces the schema object it sits in.
 *   TUPLE-FORM `items`    asserts NOTHING here — `checkSchema` hands the whole
 *                         array to every element as if it were one subschema —
 *                         and went unreported, because the walk simply treats an
 *                         array as a list of subschemas. No vendored schema uses
 *                         the form, so it is REPORTED rather than implemented:
 *                         positional item schemas are a real feature, and half of
 *                         one is worse than none.
 */

/** Keywords the evaluator applies at an ORDINARY schema position. */
const SCHEMA_KEYWORDS = new Set([
  "$defs", "$ref", "allOf", "oneOf", "const", "enum", "type", "minLength", "pattern", "not",
  "minItems", "uniqueItems", "items", "required", "properties", "propertyNames",
  "additionalProperties",
]);

/** Carry no assertion at all; their contents are prose or identifiers. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "examples", "default", "deprecated", "$comment"]);

/** Values are DATA, not subschemas: never walked as if they held keywords. A
 * `default: { minimum: 3 }` is a default value that happens to look like one. */
const DATA_VALUED = new Set(["const", "enum", "required", "examples", "default"]);

/** Values are maps of NAME → subschema. */
const SCHEMA_MAPS = new Set(["properties", "$defs"]);

/** Values are a subschema, or a list of them. */
const SCHEMA_VALUED = new Set(["allOf", "oneOf", "items", "additionalProperties"]);

/** …but only these may legally BE a list. `items: [A, B]` is the tuple form,
 * which this evaluator does not apply, so an array here is reported rather than
 * walked as if it were an ordinary list of subschemas. */
const LIST_VALUED = new Set(["allOf", "oneOf"]);

/** Keywords read only for the sub-keywords listed — everything else inside them
 * is ignored by checkSchema and must therefore be reported. */
const PARTIALLY_READ = {
  not: new Set(["pattern"]),
  propertyNames: new Set(["pattern", "minLength"]),
};

/**
 * Every keyword appearing anywhere in `schema` that this evaluator does not
 * implement AT THE POSITION IT APPEARS, with the JSON-pointer-ish path where it
 * appears.
 * @returns {string[]} empty means the schema is fully covered
 */
export function unsupportedKeywords(schema, at = "#") {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}/${i}`)); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (ANNOTATIONS.has(key)) continue;
      if (Object.hasOwn(PARTIALLY_READ, key)) {
        // Inside these, only the listed sub-keywords are applied. Anything else
        // is silently ignored by checkSchema, which is exactly what this
        // function exists to surface.
        for (const sub of Object.keys(value && typeof value === "object" ? value : {})) {
          if (!PARTIALLY_READ[key].has(sub)) out.push(`${path}/${key}/${sub}`);
        }
        continue;
      }
      if (!SCHEMA_KEYWORDS.has(key)) { out.push(`${path}/${key}`); continue; }
      if (DATA_VALUED.has(key)) continue;                       // a VALUE, not a schema
      if (SCHEMA_MAPS.has(key)) {
        for (const [name, sub] of Object.entries(value || {})) walk(sub, `${path}/${key}/${name}`);
        continue;
      }
      if (SCHEMA_VALUED.has(key)) {
        // An array where only a single subschema is applied: the tuple form of
        // `items`. checkSchema passes the whole array to every element, which
        // asserts nothing at all, so the POSITION is reported.
        if (Array.isArray(value) && !LIST_VALUED.has(key)) { out.push(`${path}/${key}`); continue; }
        walk(value, `${path}/${key}`);
        continue;
      }
      // Everything left is a scalar assertion ($ref, type, pattern, minLength,
      // minItems, uniqueItems): nothing below it to walk.
    }
  };
  walk(schema, at);
  return out;
}

/**
 * @param value the document (or fragment) under test
 * @param schema the schema (or subschema) to apply
 * @param at human-readable path of `value`, used in messages
 * @param rootSchema the schema `$ref`s resolve against
 * @param emit (path, message) => void — collects a problem
 */
export function checkSchema(value, schema, at, rootSchema, emit) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { emit(at, "is not allowed here"); return; }
  if (typeof schema !== "object") return;
  // $ref AND oneOf ARE CONSTRAINTS, NOT REPLACEMENTS. Both used to `return`
  // here, which silently dropped every keyword sitting beside them — and the
  // vendored lock schema's ROOT is exactly that shape (`type` and `required`
  // beside a two-branch `oneOf`), so two of its assertions were dead code no
  // report mentioned. Falling through is both the 2020-12 reading and the only
  // fix available for a schema this package copies byte for byte.
  if (schema.$ref) {
    const target = schema.$ref.startsWith("#/$defs/") ? rootSchema?.$defs?.[schema.$ref.slice("#/$defs/".length)] : undefined;
    if (target) checkSchema(value, target, at, rootSchema, emit);
  }
  if (schema.allOf) for (const sub of schema.allOf) checkSchema(value, sub, at, rootSchema, emit);
  if (schema.oneOf) {
    // Branches are tried into throwaway buckets so a failing alternative does
    // not pollute the caller's problem list with the reason it was not chosen.
    const failures = schema.oneOf.map((sub) => { const bucket = []; checkSchema(value, sub, at, rootSchema, (p, m) => bucket.push(`${p}: ${m}`)); return bucket; });
    if (!failures.some((bucket) => bucket.length === 0)) emit(at, `matches none of the allowed forms (${failures.flat().join("; ")})`);
  }
  if ("const" in schema && !Object.is(value, schema.const)) emit(at, `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) emit(at, `must be one of ${schema.enum.join(", ")}`);
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && actual !== schema.type) { emit(at, `must be ${schema.type}, got ${actual}`); return; }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) emit(at, `must contain at least ${schema.minLength} character(s)`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) emit(at, `must match ${schema.pattern}`);
    if (schema.not?.pattern && (new RegExp(schema.not.pattern)).test(value)) emit(at, `must not match ${schema.not.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) emit(at, `must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) emit(at, "must contain unique items");
    value.forEach((item, index) => checkSchema(item, schema.items, `${at}[${index}]`, rootSchema, emit));
  }
  if (value && actual === "object") {
    // OWN properties only, everywhere. `"constructor" in {}` is true — as are
    // toString, valueOf, hasOwnProperty and five more — so an `in` test against
    // a schema's `properties` map dispatches an inherited FUNCTION as if it were
    // a subschema, and `additionalProperties: false` never fires. A manifest
    // carrying a root `constructor:` key would then pass this gate and be
    // rejected only later, by the kernel, in the adopter's deployment.
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) emit(at, `missing required property ${key}`);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames?.pattern && !(new RegExp(schema.propertyNames.pattern)).test(key)) emit(`${at}.${key}`, `property name must match ${schema.propertyNames.pattern}`);
      // The vendored lock schema's capability map constrains its keys by LENGTH
      // rather than by pattern (`propertyNames: { minLength: 1 }`), so an empty
      // capability id was accepted by every gate until this line existed.
      if (schema.propertyNames?.minLength !== undefined && key.length < schema.propertyNames.minLength) {
        emit(`${at}.${key}`, `property name must contain at least ${schema.propertyNames.minLength} character(s)`);
      }
      if (Object.hasOwn(properties, key)) checkSchema(item, properties[key], `${at}.${key}`, rootSchema, emit);
      else if (schema.additionalProperties === false) emit(`${at}.${key}`, "unknown property");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") checkSchema(item, schema.additionalProperties, `${at}.${key}`, rootSchema, emit);
    }
  }
}

/**
 * The whole document against a whole schema.
 * @returns {string[]} `"<path>: <message>"` lines; empty means valid
 */
export function schemaProblems(value, schema, at = "$") {
  const problems = [];
  checkSchema(value, schema, at, schema, (path, message) => problems.push(`${path}: ${message}`));
  return problems;
}
