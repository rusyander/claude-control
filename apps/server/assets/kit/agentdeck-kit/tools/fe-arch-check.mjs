#!/usr/bin/env node
// fe-arch-check — the cross-file shape of the frontend doctrine (skill frontend-architecture:
// colocation.md, styles.md, structure.md) that no per-file linter sees.
//
// Why a tool: until 23.09.2026 lint-enforcement.md, structure.md and the eslint template all pointed
// here while nothing existed; the only working gate was one project's in-repo architecture.test.ts
// (2026), after dependency-cruiser v18 refused TypeScript 7 and reported a silent zero. The rules below
// are that test's structural half, generalised, plus the `.tsx`-only selectors from another project for projects
// that lack the ESLint block.
//
//   node <kit>/tools/fe-arch-check.mjs <src> [--rules R1,R5] [--ignore <regex>] [--json]
//
// R1 one component per .tsx          R2 one component .tsx per directory (fold at >=2)
// R3 a satellite sits beside its component (`X.module.scss` next to `X/` is the standing mistake)
// R4 no barrel inside a component folder (a slice root, the direct child of a layer, keeps its index)
// R5 a stylesheet outside `shared` has at most one importer
// R6 a .tsx holds only the component: no top-level type/interface, lowercase function, SCREAMING or
//    lowercase const          R7 no `composes … from` across a folder (from `shared` licensed)
//
// Heuristic, not a parser: declarations are read at column 0 (formatted code), comments stripped.
// Exempt everywhere: tests/specs/stories (satellites), composition roots (`main.tsx` at any depth, any
// lowercase .tsx at the scan root — e.g. a widget's module.tsx), --ignore matches
// (a regex over the root-relative path, forward slashes). Imports resolve relative, `@/`, `~/`,
// `src/`, `@<layer>/`; anything else counts as unresolved and is printed, never silently dropped.
// Read-only. Exit: 0 clean · 1 violations · 2 usage error or zero component .tsx read (wrong root —
// a gate that reads nothing must not pass).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const RULES = {
  R1: 'one component per .tsx',
  R2: 'one component .tsx per directory',
  R3: 'satellite beside its component',
  R4: 'no barrel inside a component folder',
  R5: 'stylesheet outside shared has one importer',
  R6: '.tsx holds only the component',
  R7: 'no composes across folders',
};
const LAYERS = /^(app|pages|widgets|features|entities|shared|processes)$/;
const SLICE_PARENTS = /^(pages|widgets|features|entities|processes)$/;
const SKIP_DIRS = /^(node_modules|dist|build|coverage|storybook-static|\..*)$/;
const STYLE = /\.module\.(scss|sass|css|less)$/;
const TEST = /\.(test|spec|stories)\.[tj]sx?$/;
const SATELLITE =
  /^([A-Z][A-Za-z0-9]*)\.(types|constants|mock|stories|test|spec)\.tsx?$|^([A-Z][A-Za-z0-9]*)\.module\.(scss|sass|css|less)$/;
const ROOT_FILE = /^[a-z][\w-]*\.tsx$/; // lowercase .tsx at the scan root = composition root

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = argv.includes('--json');
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !['--rules', '--ignore'].includes(argv[i - 1]),
);

function usage(msg) {
  console.error(
    `fe-arch-check: ${msg}\nusage: node fe-arch-check.mjs <src> [--rules R1,R5] [--ignore <regex>] [--json]`,
  );
  process.exit(2);
}

if (positional.length !== 1) usage('exactly one <src> directory expected');
const ROOT = path.resolve(positional[0]);
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) usage(`not a directory: ${ROOT}`);
const selected = opt('--rules')
  ? opt('--rules')
      .split(',')
      .map((r) => r.trim().toUpperCase())
  : Object.keys(RULES);
const unknownRule = selected.find((r) => !RULES[r]);
if (unknownRule) usage(`unknown rule ${unknownRule} (known: ${Object.keys(RULES).join(', ')})`);
let IGNORE = null;
if (opt('--ignore')) {
  try {
    IGNORE = new RegExp(opt('--ignore'));
  } catch (e) {
    usage(`--ignore is not a regex: ${e.message}`);
  }
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/') || '.';
const ignored = (abs) => IGNORE !== null && IGNORE.test(rel(abs));

// ---------------------------------------------------------------- walk
const dirs = []; // { abs, files: string[] }
(function walk(dir) {
  if (dir !== ROOT && ignored(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.test(e.name)) walk(abs);
    } else if (e.isFile() && !ignored(abs)) files.push(e.name);
  }
  dirs.push({ abs: dir, files });
})(ROOT);

/** Comments out: prose about imports and components must not read as code. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const COMPONENT_DECL = [
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Z]\w*)/gm,
  /^(?:export\s+)?(?:const|let)\s+([A-Z][a-z0-9]\w*)\b[^=\n]*=\s*(?:(?:React\.)?(?:memo|forwardRef|observer)\s*(?:<[^>\n]*>)?\s*\(\s*)?(?:async\s+)?(?:function\b|\(|<[A-Za-z][^>\n]*>\s*\(|[a-z_$][\w$]*\s*=>)/gm,
  /^(?:export\s+(?:default\s+)?)?class\s+([A-Z]\w*)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/gm,
];
function componentsIn(text) {
  const names = [];
  for (const re of COMPONENT_DECL) for (const m of text.matchAll(re)) names.push(m[1]);
  return names;
}

const NON_COMPONENT = [
  {
    re: /^(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/gm,
    what: (m) => `${m[1]} ${m[2]} → <Name>.types.ts`,
  },
  {
    re: /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-z_$][\w$]*)/gm,
    what: (m) => `function ${m[1]} → lib/ or hooks/`,
  },
  {
    re: /^(?:export\s+)?(?:const|let|var)\s+((?:[A-Z][A-Z0-9_]*|[a-z_$][\w$]*))(?![\w$])/gm,
    what: (m) => `const ${m[1]} → <Name>.constants.ts or lib/`,
  },
];

// ---------------------------------------------------------------- imports
function resolveSpecifier(spec, fromAbs) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromAbs), spec);
  let m = /^(?:@|~)\/(.+)$/.exec(spec) || /^src\/(.+)$/.exec(spec);
  if (m) return path.join(ROOT, m[1]);
  m = /^@([a-z]+)\/(.+)$/.exec(spec);
  if (m && LAYERS.test(m[1]) && existsSync(path.join(ROOT, m[1])))
    return path.join(ROOT, m[1], m[2]);
  return null;
}
function specifiersIn(text) {
  const out = [];
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

const underShared = (abs) => {
  const segs = rel(abs).split('/');
  const up = path.basename(ROOT) === 'shared' || path.basename(path.dirname(ROOT)) === 'shared';
  return up || segs.slice(0, -1).includes('shared');
};

// ---------------------------------------------------------------- rules
const violations = [];
const add = (rule, abs, detail) => {
  if (selected.includes(rule)) violations.push({ rule, path: rel(abs), detail });
};
const stats = {
  dirs: dirs.length,
  tsx: 0,
  componentTsx: 0,
  stylesheets: 0,
  styleImports: 0,
  unresolved: [],
};
const importers = new Map(); // stylesheet abs → Set of importer rel paths

for (const { abs: dir, files } of dirs) {
  const base = path.basename(dir);
  const componentFiles = [];

  for (const name of files) {
    const abs = path.join(dir, name);
    if (STYLE.test(name)) stats.stylesheets++;

    // R3 — a satellite whose component is not in the same directory.
    const sat = SATELLITE.exec(name);
    if (sat) {
      const owner = sat[1] ?? sat[3];
      const kind = sat[2] ?? 'module';
      const ownerHere = files.includes(`${owner}.tsx`) || files.includes(`${owner}.ts`);
      const sliceShared = owner === base && ['types', 'constants', 'mock'].includes(kind);
      if (!ownerHere && !sliceShared) add('R3', abs, `no ${owner}.tsx beside it`);
    }

    if (!/\.[tj]sx?$/.test(name) || name.endsWith('.d.ts')) continue;
    const text = code(readFileSync(abs, 'utf8'));

    // R5 input — who imports which stylesheet (tests and stories do not own a sheet).
    if (!TEST.test(name)) {
      for (const spec of specifiersIn(text)) {
        if (!STYLE.test(spec)) continue;
        stats.styleImports++;
        const target = resolveSpecifier(spec, abs);
        if (!target) {
          stats.unresolved.push(`${rel(abs)} → ${spec}`);
          continue;
        }
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(rel(abs));
      }
    }

    if (
      !name.endsWith('.tsx') ||
      TEST.test(name) ||
      name === 'main.tsx' ||
      (dir === ROOT && ROOT_FILE.test(name))
    )
      continue;
    stats.tsx++;
    const declared = componentsIn(text);
    // A lowercase .tsx declaring nothing (index.tsx barrel, a constants.tsx) is not a second
    // component — R4/R6 speak for it. A PascalCase file counts even when the detector misses its component.
    const componentFile =
      /^[A-Z][^.]*\.tsx$/.test(name) || (/^[^.]+\.tsx$/.test(name) && declared.length > 0);
    if (componentFile) componentFiles.push(name);

    if (declared.length > 1) add('R1', abs, declared.join(', '));

    for (const { re, what } of NON_COMPONENT)
      for (const m of text.matchAll(re)) add('R6', abs, what(m));
  }

  stats.componentTsx += componentFiles.length;
  if (componentFiles.length > 1) add('R2', dir, componentFiles.join(', '));

  // R4 — index next to the folder's own component; a slice root (child of a layer) keeps its API.
  const barrel = files.find((f) => /^index\.tsx?$/.test(f));
  const sliceRoot = SLICE_PARENTS.test(path.basename(path.dirname(dir)));
  if (barrel && files.includes(`${base}.tsx`) && !sliceRoot)
    add('R4', path.join(dir, barrel), `re-exports ${base}.tsx`);

  // R7 — composes reaching into another folder.
  for (const name of files.filter((f) => STYLE.test(f))) {
    const abs = path.join(dir, name);
    const css = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/composes\s*:\s*([^;}]+)/g)) {
      const from = /\bfrom\s+['"]([^'"]+)['"]/.exec(m[1]);
      if (!from) continue;
      const target = resolveSpecifier(from[1], abs);
      // The kit is licensed to be shared (styles.md): a target inside shared, or a shared package, passes.
      const kit = target ? underShared(target) : /(^|[/@-])shared([/-]|$)/.test(from[1]);
      if (kit) continue;
      if (!target || path.dirname(target) !== dir) add('R7', abs, `composes from ${from[1]}`);
    }
  }
}

for (const [sheet, by] of importers) {
  if (by.size > 1 && !underShared(sheet))
    add('R5', sheet, `${by.size} importers: ${[...by].sort().join(', ')}`);
}

// ---------------------------------------------------------------- report
violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));
const readNothing = stats.tsx === 0;
const exit = readNothing ? 2 : violations.length ? 1 : 0;

if (JSON_OUT) {
  const unresolved = stats.unresolved;
  console.log(
    JSON.stringify(
      {
        root: ROOT,
        rules: selected,
        stats: { ...stats, unresolved: unresolved.length },
        unresolved,
        violations,
        exit,
      },
      null,
      2,
    ),
  );
  process.exit(exit);
}

console.log(
  `fe-arch-check ${ROOT}\nread: ${stats.dirs} dirs, ${stats.tsx} .tsx (${stats.componentTsx} component files), ` +
    `${stats.stylesheets} stylesheets, ${stats.styleImports} stylesheet imports (${stats.unresolved.length} unresolved)`,
);
if (readNothing) {
  console.log('NO component .tsx read — wrong root? A gate that reads nothing does not pass.');
  process.exit(2);
}
for (const u of stats.unresolved) console.log(`  unresolved: ${u}`);
for (const rule of selected) {
  const hits = violations.filter((v) => v.rule === rule);
  console.log(`\n${rule} ${RULES[rule]}: ${hits.length}`);
  for (const v of hits) console.log(`  ${v.path} — ${v.detail}`);
}
console.log(`\n${violations.length} violation(s)`);
process.exit(exit);
