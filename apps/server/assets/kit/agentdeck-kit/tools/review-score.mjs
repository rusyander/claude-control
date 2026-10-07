#!/usr/bin/env node
// Recomputes the two header lines of a deep-review report from the findings under them:
//   **Summary:** 🔴 n · 🟡 n · 🟢 n — blocking: F-..      **Score:** raised · published · confirmed by author
// A header number is a claim about the file; typed by hand it drifts the moment a fix agent flips a
// `Status` (an audit of 34 real reports: `Score` present in 7, stale in most of those).
//   node <kit>/tools/review-score.mjs <report.agent.md>            print the computed lines + status tally
//   node <kit>/tools/review-score.mjs <report.agent.md> --check    exit 1 when the header contradicts the file
//   node <kit>/tools/review-score.mjs <report.agent.md> --write    rewrite the two lines in place
// Counting rules (parser shared with the write-time guard, hooks/lib/review-report.mjs):
//   raised       = `F-NN` findings + `- ✗ …` lines (candidates that died under proof)
//   published    = findings carrying a `**Thread:**` line
//   confirmed    = findings whose `Status` is `accepted` (author agreed) or `fixed` (re-verified); "awaiting replies" while every published one is open
// `raised` is never LOWERED by --write: a candidate dropped without a ✗ line exists only in the typed number.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseReport, scoreLines, headerMismatch } from '../hooks/lib/review-report.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flags = new Set(argv.filter((a) => a.startsWith('--')));
if (!file) {
  console.error('usage: review-score.mjs <report.agent.md> [--check|--write]');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`review-score: cannot read ${file}: ${e.code ?? e.message}`);
  process.exit(2);
}

const parsed = parseReport(text);
if (!parsed.findings.length && !parsed.killed) {
  console.error(
    'review-score: no `## F-NN <severity> …` heading found — not a findings file, or a legacy layout. Nothing computed.',
  );
  process.exit(2);
}

// Never lower a typed "raised": what died without a ✗ line is recorded nowhere else.
const typedRaised = Number(text.match(/^\*\*Score:\*\*.*?raised\s*(\d+)/m)?.[1] ?? 0);
const computedRaised = parsed.findings.length + parsed.killed;
const lines = scoreLines(parsed);
if (typedRaised > computedRaised)
  lines.score = lines.score.replace(/raised \d+/, `raised ${typedRaised}`);

const tally = {};
for (const f of parsed.findings)
  tally[f.status ?? 'no status'] = (tally[f.status ?? 'no status'] ?? 0) + 1;

console.log(lines.itog);
console.log(lines.score);
console.log(
  `statuses: ${Object.entries(tally)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')}` + (parsed.killed ? ` · dropped under proof ${parsed.killed}` : ''),
);

if (flags.has('--check')) {
  const wrong = headerMismatch(text, parsed);
  for (const key of ['Summary', 'Score'])
    if (!new RegExp(`^\\*\\*${key}:\\*\\*`, 'm').test(text))
      wrong.push(`no "${key}" line in the header`);
  if (wrong.length) {
    console.log('MISMATCH:\n  ' + wrong.join('\n  '));
    process.exit(1);
  }
  console.log('header matches the findings');
}

if (flags.has('--write')) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(/\r?\n/);
  const put = (key, line) => {
    const at = rows.findIndex((r) => r.startsWith(`**${key}:**`));
    if (at >= 0) {
      rows[at] = line;
      return;
    }
    // No such line yet: it joins the header block — after its last `**…:**` line, else after the H1.
    const firstSection = rows.findIndex((r) => /^##\s/.test(r));
    const head = rows.slice(0, firstSection < 0 ? rows.length : firstSection);
    let after = -1;
    head.forEach((r, i) => {
      if (/^\*\*[^*]+:\*\*/.test(r)) after = i;
    });
    if (after < 0) after = head.findIndex((r) => /^#\s/.test(r));
    rows.splice(after + 1, 0, line);
  };
  put('Summary', lines.itog);
  put('Score', lines.score);
  const next = rows.join(eol);
  if (next !== text) writeFileSync(file, next);
  console.log(next !== text ? 'written' : 'no change');
}
