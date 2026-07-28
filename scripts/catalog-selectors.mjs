#!/usr/bin/env node
// Deterministic catalog-selector replacement gate for oas.dev dependencies.
//
// Pre-publication, oas.dev depends on its three sibling official packages by
// LOCAL package-root-relative path pointing at each sibling repo's DISTRIBUTED
// payload root (`oas-package/`), so a co-located consumer probe resolves a real
// dependency closure without any published catalog entry (the engine supports
// relative-path dependencies between co-located local packages).
//
// At publication each local path is replaced by an immutable official catalog
// selector. That replacement is FULLY DETERMINISTIC — this module IS the
// mapping and the gate, never a free-form TODO placeholder in the manifest:
//
//   ../../oas-okf/oas-package        ->  oas.okf@<release version>
//   ../../oas-aweb/oas-package       ->  oas.aweb@<release version>
//   ../../oas-authoring/oas-package  ->  oas.authoring@<release version>
//
// The catalog version is read deterministically from each sibling package's own
// oas-package.json release version, so `--apply` produces exactly the selectors
// the released sibling packages define — no human guess, no placeholder.
//
// Usage (run from the package root):
//   node scripts/catalog-selectors.mjs --check   # verify pre-publication local form + resolvable release siblings
//   node scripts/catalog-selectors.mjs --print   # print the deterministic catalog selectors
//   node scripts/catalog-selectors.mjs --apply   # rewrite oas-package.json to catalog form (publication only)

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The package root (`oas-package/`) is where oas-package.json lives; this dev
// tool sits in the sibling repo-level `scripts/` dir, so the payload root is
// `../oas-package` from here. Sibling deps are resolved relative to it.
export const ROOT = resolve(fileURLToPath(new URL("../oas-package", import.meta.url)));

// Ordered, exhaustive local-form -> catalog-id mapping: oas.dev's exact
// pre-publication dependency list, in order. Each local path points at the
// sibling repo's DISTRIBUTED payload root. Jira and Linear are deliberately
// absent — they remain adopter-selected, never oas.dev dependencies.
export const SELECTOR_MAP = [
  { local: "../../oas-okf/oas-package", catalog: "oas.okf", version: "1.4.1" },
  { local: "../../oas-aweb/oas-package", catalog: "oas.aweb", version: "1.8.0" },
  { local: "../../oas-authoring/oas-package", catalog: "oas.authoring", version: "1.0.0" },
];

export const LOCAL_FORM = SELECTOR_MAP.map((e) => e.local);
export const PUBLISHED_FORM = SELECTOR_MAP.map((e) => `${e.catalog}@v${e.version}`);

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "oas-package.json"), "utf8"));
}

/** Deterministic catalog selector for one entry; the version is read from the
 * co-located sibling package's own release version, making the swap exact. */
export function catalogSelector(entry, { root = ROOT, verifySibling = true } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`mapped ${entry.catalog} has invalid release version "${entry.version}"`);
  const siblingDir = resolve(root, entry.local);
  if (verifySibling) {
    const manifest = readManifest(siblingDir);
    if (manifest.package !== entry.catalog)
      throw new Error(`sibling at ${entry.local} declares package "${manifest.package}", expected "${entry.catalog}"`);
    if (manifest.version !== entry.version)
      throw new Error(`sibling ${entry.catalog} is ${manifest.version}, selector map pins ${entry.version}`);
  }
  return `${entry.catalog}@v${entry.version}`;
}

export function catalogSelectors(opts = {}) {
  return SELECTOR_MAP.map((e) => catalogSelector(e, opts));
}

/** Verify the manifest is currently in the exact pre-publication local form and
 * that every local path resolves to the right sibling at a release version —
 * this is what makes the catalog replacement deterministic rather than a guess. */
export function checkLocalForm({ root = ROOT } = {}) {
  const deps = readManifest(root).dependencies;
  if (!Array.isArray(deps)) throw new Error("oas-package.json has no dependencies array");
  const same = deps.length === LOCAL_FORM.length && deps.every((d, i) => d === LOCAL_FORM[i]);
  if (!same)
    throw new Error(
      `dependencies are not the expected pre-publication local form.\n  found: ${JSON.stringify(deps)}\n  want:  ${JSON.stringify(LOCAL_FORM)}`,
    );
  const selectors = catalogSelectors({ root });
  return { deps, selectors };
}

/** Rewrite oas-package.json dependencies to the deterministic catalog form.
 * Publication-only; pre-publication CI keeps the local form. */
export function checkPublishedForm({ root = ROOT } = {}) {
  const deps = readManifest(root).dependencies;
  if (!Array.isArray(deps)) throw new Error("oas-package.json has no dependencies array");
  const same = deps.length === PUBLISHED_FORM.length && deps.every((d, i) => d === PUBLISHED_FORM[i]);
  if (!same) throw new Error(`dependencies are not the expected published form.\n  found: ${JSON.stringify(deps)}\n  want:  ${JSON.stringify(PUBLISHED_FORM)}`);
  return { deps, selectors: catalogSelectors({ root, verifySibling: false }) };
}

export function applyCatalogForm({ root = ROOT, write = true } = {}) {
  const path = join(root, "oas-package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const published = Array.isArray(manifest.dependencies) && manifest.dependencies.length === PUBLISHED_FORM.length
    && manifest.dependencies.every((d, i) => d === PUBLISHED_FORM[i]);
  const selectors = catalogSelectors({ root, verifySibling: !published });
  manifest.dependencies = selectors;
  const text = JSON.stringify(manifest, null, 2) + "\n";
  if (write) writeFileSync(path, text);
  return { selectors, text };
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "")) {
  const mode = process.argv[2] || "--check";
  try {
    if (mode === "--check") {
      const deps = readManifest(ROOT).dependencies;
      if (Array.isArray(deps) && deps.every((d, i) => d === PUBLISHED_FORM[i]) && deps.length === PUBLISHED_FORM.length) {
        const { selectors } = checkPublishedForm();
        console.log("published catalog form OK:", JSON.stringify(selectors));
      } else {
        const { deps: local, selectors } = checkLocalForm();
        console.log("pre-publication local form OK:", JSON.stringify(local));
        console.log("deterministic catalog replacement:", JSON.stringify(selectors));
      }
    } else if (mode === "--print") {
      console.log(catalogSelectors({ verifySibling: false }).join("\n"));
    } else if (mode === "--apply") {
      const { selectors } = applyCatalogForm();
      console.log("applied catalog selectors:", JSON.stringify(selectors));
    } else {
      console.error(`unknown mode ${mode} (use --check | --print | --apply)`);
      process.exit(2);
    }
  } catch (e) {
    console.error("catalog-selectors:", e.message || e);
    process.exit(1);
  }
}
