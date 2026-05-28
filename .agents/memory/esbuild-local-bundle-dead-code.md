---
name: esbuild local-bundle dead code elimination
description: How to reliably prevent cloud-only code from appearing in a local esbuild bundle, and the specific pitfalls of each approach.
---

## Rule

To guarantee cloud-only code is absent from a local esbuild bundle, you need **two complementary mechanisms**:

1. **`if (process.env.MIZI_DISTRIBUTION !== "local") { /* cloud code */ }`** inside function bodies  
   esbuild constant-folds this to `if (false) { }`. Combined with `minifySyntax: true` (or `minify: true`), the dead body **is fully eliminated** — including any dynamic imports inside it.

2. **A stub plugin** (`onLoad` filter) to replace cloud-only *module files* with empty stubs  
   Even with `if (false)` guards, modules that are **statically imported** (not just dynamically) get bundled because esbuild resolves the entire module graph before dead-code elimination. Stubbing those files to `"use strict"` makes their `__esm` init wrappers empty, and `minifySyntax` then eliminates the unused variable declarations.

## Why `if (true) return;` does NOT work

`if (process.env.MIZI_DISTRIBUTION === "local") return;` folds to `if (true) return;`. esbuild folds the condition but does **NOT** eliminate the unreachable code that follows — it keeps the entire function body. Dead-code body elimination only happens for `if (false) { }` blocks, and only when `minifySyntax: true` (or `minify: true`) is set.

## Why `if (false) { }` alone isn't enough

Statically imported modules (e.g. `import * as vastai from "./vastai"` in `services/templates.ts`) are added to the module graph *before* dead-code elimination runs. Even if the only call site is inside `if (false)`, the module wrapper (`init_vastai`) still appears in the bundle. The stub plugin prevents this by making the module content empty, so `init_vastai` becomes an empty wrapper that `minifySyntax` eliminates as an unused variable.

## Required stub targets (local build)

All files that **statically** import `vastai` or `fly`:

- `services/vastai.ts`
- `services/fly.ts`
- `services/templates.ts`
- `routes/sessions.ts`
- `routes/offers.ts`
- `routes/templates.ts`
- `routes/orchestrate.ts`

## Build config requirements

```js
minifySyntax: IS_LOCAL,          // enables if(false) body elimination
plugins: [localCloudStubPlugin()], // stubs static importers of cloud modules
```

## Scan patterns that are safe to remove

- `init_vastai`, `vastai_exports`, `init_fly`, `fly_exports` — esbuild wrapper names for **empty** stubs; not functional cloud code
- Check instead for actual API strings that survive in live code paths
