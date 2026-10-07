# Lint enforcement of the frontend doctrine

Structural rules hold on a gate, never on the agent's memory. Case (a real project): "types,
constants and helpers out of `.tsx`" lived in three prose places — code guidelines, the binding, a memory —
and the review still counted 14 inline component types, 62 module constants and 10 helpers. ESLint was the
gate and did not check it; prose loses to the gate. **Ready configs live in this skill's `config/`**;
insert on consent (new devDeps), extend/override per project. Check versions against the plugins' current
docs before installing.

## Ready files (`config/`)

| File                                                                                                                  | Purpose                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `eslint.config.mjs.txt` (copy as `eslint.config.mjs`)                                                                 | Flat config (ESLint 9+): FSD boundaries, barrel imports, no-default-export, naming, `max-lines`, `no-nested-ternary` |
| `tsconfig.base.json.txt` (copy as `tsconfig.base.json`; shipped as .txt so no tool mistakes the kit for a TS project) | Strict TS (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) + path aliases                              |
| `.dependency-cruiser.cjs`                                                                                             | FSD boundaries/cycles/orphans/deep imports (reinforces ESLint)                                                       |
| `prettierrc.json.txt` (copy as `.prettierrc.json`)                                                                    | Formatting                                                                                                           |

## What catches what

| Doctrine rule                                                                                                                                                                            | Tool                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| FSD boundaries (downward only), no cross-feature                                                                                                                                         | `eslint-plugin-boundaries` + `.dependency-cruiser.cjs`                                |
| External import only via `index.ts`                                                                                                                                                      | `import/no-internal-modules`, `boundaries/no-private`                                 |
| Named exports (ADR-003)                                                                                                                                                                  | `no-restricted-syntax` (ExportDefaultDeclaration)                                     |
| Naming: project PascalCase, `shared` kebab                                                                                                                                               | `eslint-plugin-check-file`                                                            |
| ~400 lines (signal, warn), with exceptions                                                                                                                                               | `max-lines` + override for test/constants/mock/stories                                |
| No nested ternaries/extra nesting                                                                                                                                                        | `no-nested-ternary`, `no-lonely-if`                                                   |
| Cycles, orphans, deep imports                                                                                                                                                            | `dependency-cruiser`                                                                  |
| `.tsx` holds only the component + JSX                                                                                                                                                    | `no-restricted-syntax` selectors below                                                |
| Folder per component, fold at ≥2, satellites inside, no barrel in a component folder, one `.tsx` per directory, one importer per stylesheet outside `shared`, no cross-folder `composes` | `node <kit>/tools/fe-arch-check.mjs <src>` — cross-file shape no per-file linter sees |

Plugin install:
`npm i -D eslint typescript-eslint eslint-plugin-boundaries eslint-plugin-import eslint-plugin-check-file eslint-plugin-react-hooks dependency-cruiser`

## `.tsx` = component + JSX only (real-project precedent)

Block `files: ['src/**/*.tsx']`, with tests/stories/composition roots (`main.tsx`, module manifests) in a
later override:

```js
const atTopLevel = (n) => `Program > ${n}, Program > ExportNamedDeclaration > ${n}`
'no-restricted-syntax': ['error',
  { selector: `${atTopLevel('TSInterfaceDeclaration')}, ${atTopLevel('TSTypeAliasDeclaration')}`, message: 'Types → <Name>.types.ts' },
  { selector: atTopLevel('FunctionDeclaration[id.name=/^[a-z]/]'), message: 'Helpers → lib/, hooks → hooks/' },
  { selector: atTopLevel('VariableDeclaration > VariableDeclarator[id.name=/^([A-Z][A-Z0-9_]*$|[a-z])/]'), message: 'Values → <Name>.constants.ts' },
]
```

`no-restricted-syntax` is REPLACED, not merged, per config block — keep every selector in one shared
constant and repeat it in each block that sets the rule. The const selector's second branch (`[a-z]`)
matters: until 04.08 only SCREAMING_CASE was caught and camelCase helpers/objects slipped past.

## A gate must be seen reading

A linter that reads nothing reports "no violations". One project (2026): dependency-cruiser v18 refused
the project's TypeScript 7 and returned a silent zero — the project dropped it for an in-repo architecture
test. Before trusting any structural gate's green, plant one violation and watch it go red
(`tools/mustfail.mjs --mutate`). `fe-arch-check` exits 2 when it finds no component files at all.

`fe-arch-check <src> [--rules R1,R5] [--ignore <regex>] [--json]` — R1 one component per `.tsx` · R2 one
component `.tsx` per directory · R3 satellite beside its component · R4 no barrel in a component folder
(slice roots keep theirs) · R5 one importer per stylesheet outside `shared` · R6 `.tsx` = component only
(the selectors above, for projects without them — with the ESLint block in place pass `--rules`
without R6) · R7 no `composes` across folders (from `shared` licensed). Test harness dirs →
`--ignore '^test/'`. Calibrated on two real projects: structural rules 0 = one project's own `architecture.test.ts` 74/74;
the other's R5 38/38 against an independent importer count, both directions.

## Wiring into verification

Add to the project's check command (e.g. `npm run check` = format → type-check → **lint** →
`depcruise src` → build) and CI. Structural regressions fail immediately instead of piling up.

## Conflict with an existing linter

Project has its own ESLint/Prettier/Biome → **project wins** (conflict protocol in SKILL.md). Blend in
only non-conflicting doctrine rules, contested ones on explicit consent. Linting cannot name-check
`*.module.scss` — add `stylelint` separately if wanted.
