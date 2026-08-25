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
 * pattern, not.pattern, minItems, uniqueItems, items, required, properties,
 * propertyNames.pattern, additionalProperties (false or subschema).
 *
 * NOT SUPPORTED, and absent from all four vendored schemas: anyOf, if/then/else,
 * $ref outside $defs, numeric bounds, format, dependent schemas. A schema that
 * grows one of these silently gets weaker validation, so `unsupportedKeywords`
 * exists to make that visible at the call site rather than at an adopter's
 * install.
 */

/** Keywords this evaluator understands. Anything else in a schema is ignored,
 * which is why callers can ask about it. */
const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "examples", "default", "deprecated",
  "allOf", "oneOf", "const", "enum", "type", "minLength", "pattern", "not",
  "minItems", "uniqueItems", "items", "required", "properties", "propertyNames",
  "additionalProperties",
]);

/**
 * Every keyword appearing anywhere in `schema` that this evaluator does not
 * implement, with the JSON-pointer-ish path where it appears.
 * @returns {string[]} empty means the schema is fully covered
 */
export function unsupportedKeywords(schema, at = "#") {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}/${i}`)); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      // Below `properties`/`$defs` the keys are NAMES, not keywords.
      if (key === "properties" || key === "$defs") {
        for (const [name, sub] of Object.entries(value || {})) walk(sub, `${path}/${key}/${name}`);
        continue;
      }
      if (!KNOWN_KEYWORDS.has(key)) out.push(`${path}/${key}`);
      walk(value, `${path}/${key}`);
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
  if (schema.$ref) {
    const target = schema.$ref.startsWith("#/$defs/") ? rootSchema?.$defs?.[schema.$ref.slice("#/$defs/".length)] : undefined;
    if (target) checkSchema(value, target, at, rootSchema, emit);
    return;
  }
  if (schema.allOf) for (const sub of schema.allOf) checkSchema(value, sub, at, rootSchema, emit);
  if (schema.oneOf) {
    // Branches are tried into throwaway buckets so a failing alternative does
    // not pollute the caller's problem list with the reason it was not chosen.
    const failures = schema.oneOf.map((sub) => { const bucket = []; checkSchema(value, sub, at, rootSchema, (p, m) => bucket.push(`${p}: ${m}`)); return bucket; });
    if (!failures.some((bucket) => bucket.length === 0)) emit(at, `matches none of the allowed forms (${failures.flat().join("; ")})`);
    return;
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
