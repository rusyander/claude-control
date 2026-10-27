#!/usr/bin/env node
// The rule-text snapshot (rule-texts.json) a watch reads when it runs outside the panel's repo.
//   node rule-texts.mjs --repo <panel repo> --write   rewrite the snapshot from the repo's group-watch/en.ts
//   node rule-texts.mjs --repo <panel repo> --check   exit 1 when the snapshot differs from the repo (names the ids)
import fs from 'node:fs';
import path from 'node:path';
import { RULE_TEXTS_JSON, RULE_TEXTS_SRC, parseRuleTexts } from './lib/rule-texts.mjs';

const argv = process.argv.slice(2);
const val = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repo = path.resolve(val('repo') ?? process.cwd());
const src = path.join(repo, RULE_TEXTS_SRC);
let texts;
try {
  texts = parseRuleTexts(fs.readFileSync(src, 'utf8'));
} catch (e) {
  console.log(`cannot read ${src}: ${e.message}`);
  process.exit(2);
}
if (!Object.keys(texts).length) {
  console.log(`no rule texts in ${src} — the module's shape changed, fix lib/rule-texts.mjs`);
  process.exit(2);
}
const sorted = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
if (argv.includes('--write')) {
  fs.writeFileSync(RULE_TEXTS_JSON, `${JSON.stringify({ source: RULE_TEXTS_SRC.replace(/\\/g, '/'), texts: sorted }, null, 1)}\n`);
  console.log(`rule-texts.json: ${Object.keys(sorted).length} texts`);
} else {
  let have = {};
  try {
    have = JSON.parse(fs.readFileSync(RULE_TEXTS_JSON, 'utf8')).texts ?? {};
  } catch {
    /* no snapshot = every id differs */
  }
  const ids = [...new Set([...Object.keys(sorted), ...Object.keys(have)])].filter((k) => sorted[k] !== have[k]);
  console.log(ids.length ? `rule-texts.json stale: ${ids.join(' ')} — run with --write` : `rule-texts.json current: ${Object.keys(sorted).length} texts`);
  process.exit(ids.length ? 1 : 0);
}
