#!/usr/bin/env node
// i18n-keydiff — locale drift, plural-aware: which keys one locale has and another lacks.
//
// Why plural-aware: a naive set-diff of flattened keys reports every Russian `_few`/`_many` as drift
// against English, because i18next (v21+ JSON v4) stores plurals as `key_<category>` and each language
// has its own categories (Intl.PluralRules: ru one/few/many/other, en and uz one/other). helpdesk
// (23.09.2026): 9 `_few` + 9 `_many` in ru — a naive pairwise diff reports 36 false misses (18 keys ×
// en, uz); another project 40. This tool: 0 on both, every naive diff explained by plural categories.
// Skill i18n-audit §2.2 gate.
//
//   node <kit>/tools/i18n-keydiff.mjs <localesDir> [--json]
//
// Layouts: `<dir>/<lang>/<ns>.json` (keys become `ns:dotted.key`) or `<dir>/<lang>.json`.
// Missing = a plain key some locale has and this one lacks, or a plural form this locale's own
// categories require (`_zero` is never required — i18next treats it as an optional extra — except where
// the language has a zero category, e.g. ar). A plain `key` satisfies a plural base (i18next falls back
// to it). Warnings, not failures: plural forms the language does not use, empty-string values, a locale
// Intl has no plural rules for (checked against the forms other locales carry).
// Read-only. Exit: 0 every locale 0 missing · 1 something missing · 2 usage, <2 locales, bad JSON, 0 keys.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('--'));
function fail(msg) {
  console.error(`i18n-keydiff: ${msg}\nusage: node i18n-keydiff.mjs <localesDir> [--json]`);
  process.exit(2);
}
if (positional.length !== 1) fail('exactly one <localesDir> expected');
const DIR = path.resolve(positional[0]);
if (!existsSync(DIR) || !statSync(DIR).isDirectory()) fail(`not a directory: ${DIR}`);

// ---------------------------------------------------------------- load
const entries = readdirSync(DIR, { withFileTypes: true });
const langDirs = entries.filter(
  (e) => e.isDirectory() && readdirSync(path.join(DIR, e.name)).some((f) => f.endsWith('.json')),
);
const langFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
const layout = langDirs.length ? '<lang>/<ns>.json' : '<lang>.json';

function parse(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    fail(`bad JSON in ${path.relative(DIR, file)}: ${e.message}`);
  }
}
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const locales = new Map(); // lang → Map(key → value)
const namespaces = new Set();
if (langDirs.length) {
  for (const d of langDirs) {
    const keys = new Map();
    for (const f of readdirSync(path.join(DIR, d.name)).filter((f) => f.endsWith('.json'))) {
      const ns = f.slice(0, -5);
      namespaces.add(ns);
      for (const [k, v] of flatten(parse(path.join(DIR, d.name, f)), '', new Map()))
        keys.set(`${ns}:${k}`, v);
    }
    locales.set(d.name, keys);
  }
} else {
  for (const f of langFiles)
    locales.set(f.name.slice(0, -5), flatten(parse(path.join(DIR, f.name)), '', new Map()));
}
if (locales.size < 2) fail(`${locales.size} locale(s) found in ${DIR} — nothing to compare`);

// ---------------------------------------------------------------- plurals
const PLURAL = /^(.*?)_(ordinal_)?(zero|one|two|few|many|other)$/; // lazy: `x_ordinal_one` is ordinal x
const tagOf = (lang) => lang.replace(/_/g, '-');
const warnings = [];
function categories(lang, type) {
  const tag = tagOf(lang);
  let known;
  try {
    known = Intl.PluralRules.supportedLocalesOf([tag]).length > 0;
  } catch {
    known = false;
  }
  return known
    ? new Set(new Intl.PluralRules(tag, { type }).resolvedOptions().pluralCategories)
    : null;
}

const pluralBases = new Map(); // base → { type, formsSeen:Set }
for (const keys of locales.values()) {
  for (const k of keys.keys()) {
    const m = PLURAL.exec(k);
    if (!m) continue;
    const type = m[2] ? 'ordinal' : 'cardinal';
    const b = pluralBases.get(m[1]) ?? { type, formsSeen: new Set() };
    b.formsSeen.add(m[3]);
    pluralBases.set(m[1], b);
  }
}
const suffix = (base, type, cat) => `${base}_${type === 'ordinal' ? 'ordinal_' : ''}${cat}`;

const plainUnion = new Set();
for (const keys of locales.values())
  for (const k of keys.keys()) if (!PLURAL.exec(k) && !pluralBases.has(k)) plainUnion.add(k);

// ---------------------------------------------------------------- diff
const report = [];
let totalMissing = 0;
for (const [lang, keys] of locales) {
  const missing = [];
  const extra = [];
  for (const k of plainUnion) if (!keys.has(k)) missing.push(k);

  const cats = { cardinal: categories(lang, 'cardinal'), ordinal: categories(lang, 'ordinal') };
  if (!cats.cardinal && pluralBases.size)
    warnings.push(
      `${lang}: Intl has no plural rules — plural forms checked against those other locales carry`,
    );
  for (const [base, { type, formsSeen }] of pluralBases) {
    if (keys.has(base)) continue; // plain fallback resolves every count
    const need = cats[type] ?? formsSeen;
    for (const cat of need)
      if (!keys.has(suffix(base, type, cat)))
        missing.push(`${suffix(base, type, cat)} (plural: ${lang} needs ${cat})`);
    if (cats[type])
      for (const cat of formsSeen)
        if (cat !== 'zero' && !cats[type].has(cat) && keys.has(suffix(base, type, cat)))
          extra.push(suffix(base, type, cat));
  }
  const empty = [...keys].filter(([, v]) => v === '').map(([k]) => k);
  missing.sort();
  totalMissing += missing.length;
  report.push({
    lang,
    keys: keys.size,
    missing,
    extraPluralForms: extra.sort(),
    empty: empty.sort(),
  });
}

const keyCount = Math.max(...[...locales.values()].map((k) => k.size));
if (keyCount === 0) fail('0 keys read — empty locale files?');
const exit = totalMissing ? 1 : 0;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        dir: DIR,
        layout,
        locales: [...locales.keys()],
        namespaces: namespaces.size,
        pluralBases: pluralBases.size,
        report,
        warnings,
        exit,
      },
      null,
      2,
    ),
  );
  process.exit(exit);
}
console.log(`i18n-keydiff ${DIR}`);
console.log(
  `layout ${layout} · ${locales.size} locales (${[...locales.keys()].join(', ')})` +
    (namespaces.size ? ` · ${namespaces.size} namespaces` : '') +
    ` · ${plainUnion.size} plain keys + ${pluralBases.size} plural bases`,
);
for (const r of report) {
  console.log(`${r.lang}: ${r.missing.length} missing`);
  for (const k of r.missing) console.log(`  ${k}`);
}
for (const w of warnings) console.log(`warning: ${w}`);
for (const r of report) {
  if (r.extraPluralForms.length)
    console.log(
      `warning: ${r.lang} carries plural forms the language does not use: ${r.extraPluralForms.join(', ')}`,
    );
  if (r.empty.length)
    console.log(
      `warning: ${r.lang} has ${r.empty.length} empty value(s): ${r.empty.slice(0, 10).join(', ')}${r.empty.length > 10 ? ' …' : ''}`,
    );
}
process.exit(exit);
