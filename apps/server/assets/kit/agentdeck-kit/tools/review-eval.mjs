#!/usr/bin/env node
// Regression set for deep-review: a skill edit is measured against colleague findings on real MRs, not
// argued. A case = a frozen MR range + its ground truth (what other reviewers found, anonymised); a run =
// blind lanes → a judge matching findings to the truth → a scored row in history.jsonl keyed by the
// skill's fingerprint, so a drop is attributable to the edit that caused it.
//
//   list                                                  cases with size and last score
//   prompt <case> --dir <run dir>                         clone at head + lane plan, then one blind prompt per plan lane
//   judge-prompt <case> --reports a.md,b.md [--out judge.json]   judge prompt: truth × reports → JSON
//   score <case> --judge judge.json --label <text>        recall, blocking recall, beyond; appends history
//   harvest <review.agent.md> --case <case> [--write]     review-sync "Found by others" rows → candidates.md
//   [--evals <dir>]  default <cwd>/.agent/evals/deep-review (the project's own, never committed)
//
// Case dir: case.json {id, repo, base, head, zones[], note} · gt.md rows `- A1 [block] <where> — <what>`
// · history.jsonl · candidates.md (harvested, promoted to gt.md by hand after triage).
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The eval set is project-local working data: `.agent/` of the repo the run starts in.
const HOME = process.cwd();
const SKILL = path.join(HOME, 'skills', 'deep-review');
const GT_ROW = /^- ([A-Z]\d+) (\[block\] )?(\S+) — (.+)$/;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    out[a.slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
  }
  return out;
}

export function loadCase(evals, id) {
  const dir = path.join(evals, id);
  if (!existsSync(path.join(dir, 'case.json'))) throw new Error(`no case ${id} in ${evals}`);
  const meta = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const gt = readFileSync(path.join(dir, 'gt.md'), 'utf8')
    .split('\n')
    .map((l) => l.match(GT_ROW))
    .filter(Boolean)
    .map((m) => ({ id: m[1], block: !!m[2], where: m[3], what: m[4] }));
  const ids = new Set();
  for (const g of gt) {
    if (ids.has(g.id)) throw new Error(`duplicate truth id ${g.id}`);
    ids.add(g.id);
  }
  if (!gt.length)
    throw new Error(`${id}/gt.md has no rows of the shape \`- A1 [block] where — what\``);
  return { dir, meta, gt };
}

export function history(dir) {
  const f = path.join(dir, 'history.jsonl');
  return existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

/** The skill as it stands: SKILL.md + references, so every score names the text that produced it. */
export function fingerprint(skillDir = SKILL) {
  const h = createHash('sha256');
  const refs = path.join(skillDir, 'references');
  const files = [
    'SKILL.md',
    ...(existsSync(refs)
      ? readdirSync(refs)
          .sort()
          .map((f) => path.join('references', f))
      : []),
  ];
  for (const f of files) h.update(f).update(readFileSync(path.join(skillDir, f)));
  return h.digest('hex').slice(0, 10);
}

const fwd = (p) => p.replace(/\\/g, '/');

/** One prompt per plan lane; the clone and plan.json exist before any lane starts (no race between lanes). */
export function lanePrompts(c, { dir, clone, planFile, lanes }) {
  const { meta } = c;
  return lanes.map((id, k) =>
    [
      `Blind evaluation lane ${id} (${k + 1} of ${lanes.length}): review a merge-request range with the deep-review skill exactly as written. [no-subagents]`,
      `[return-format] deliverable ${fwd(dir)}/lane-${id}.md in the skill's report shape (Ledger line included); return ≤10 English lines: findings by severity, ledger N/M, the path.`,
      '',
      `Range: base ${meta.base}, head ${meta.head}, paths ${meta.zones.join(',')}.`,
      `Tree: ${fwd(clone)} — a scratch clone at head, prepared; read and run there only.`,
      `Plan: ${fwd(planFile)} — you are lane ${id}: your chunks, your artifacts, every round, until \`node <kit>/tools/review-plan.mjs check --plan ${fwd(planFile)} ${fwd(dir)}/lane-${id}.md\` reports your chunks covered.`,
      'Run the skill end to end at the tier it computes: sweeps, live proof where its rules call for it. Backend and DB stay read-only; no GitLab, Jira or network writes.',
      `Blind: the findings must come from the code. Out of bounds: ${fwd(path.join(HOME, '.agent', 'evals'))}/**, ${fwd(path.join(HOME, '.agent', 'tmp'))}/r*-gt/**, any .agent/reviews/ file, MR discussions, review-sync output, the tracker ticket's comments.`,
    ].join('\n'),
  );
}

/** Clone at head + lane plan, via the sibling tools, so every lane starts from the same prepared state. */
export function prepare(c, dir, { tools = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const clone = path.join(dir, 'clone');
  if (!existsSync(clone)) {
    const r = spawnSync(
      process.execPath,
      [
        path.join(tools, 'review-harness.mjs'),
        'clone',
        '--repo',
        c.meta.repo,
        '--sha',
        c.meta.head,
        '--to',
        clone,
      ],
      { encoding: 'utf8' },
    );
    if (r.status) throw new Error(`clone: ${r.stderr.trim()}`);
  }
  const planDir = path.join(dir, 'plan');
  const p = spawnSync(
    process.execPath,
    [
      path.join(tools, 'review-plan.mjs'),
      'plan',
      '--repo',
      clone,
      '--base',
      c.meta.base,
      '--head',
      c.meta.head,
      '--paths',
      c.meta.zones.join(','),
      '--out',
      planDir,
    ],
    { encoding: 'utf8' },
  );
  if (p.status) throw new Error(`plan: ${p.stderr.trim()}`);
  const plan = JSON.parse(readFileSync(path.join(planDir, 'plan.json'), 'utf8'));
  return {
    clone,
    planFile: path.join(planDir, 'plan.json'),
    lanes: plan.lanes.map((l) => l.id),
    summary: p.stdout.trim(),
  };
}

export function judgePrompt(c, reports) {
  const truth = c.gt
    .map((g) => `${g.id}${g.block ? ' [block]' : ''} ${g.where} — ${g.what}`)
    .join('\n');
  return [
    `Judge a blind review run against ground truth for case ${c.meta.id}. [no-subagents]`,
    '[return-format] deliverable: the JSON below written to the path you are given; return ≤10 English lines: matched / partial / beyond counts.',
    '',
    `Reports: ${reports.join(', ')}`,
    'Finding ref = `<report file name>#<finding id>` (the id the report prints, e.g. lane-1.md#F7).',
    '',
    'Match rules:',
    '- matched: the finding states the SAME defect — same mechanism, and the same location or the same consequence. Several findings may match one item.',
    '- partial: right location or symptom, wrong or missing mechanism. Never counted as matched.',
    '- beyond: a finding matching no item that a reviewer would still act on; give its severity mark and one line. Duplicates across lanes count once.',
    '- Unsure → not matched. Judge from the report text only; do not open the code to rescue a vague finding.',
    '',
    'Output JSON:',
    '{"matched": {"A1": ["lane-1.md#F3"]}, "partial": {"B6": ["lane-2.md#F9"]}, "beyond": [{"ref": "lane-2.md#F4", "sev": "🟡", "what": "…"}], "notes": "…"}',
    '',
    'Ground truth:',
    truth,
  ].join('\n');
}

export function score(c, judge, label, skill = fingerprint()) {
  const ids = new Set(c.gt.map((g) => g.id));
  const unknown = [...Object.keys(judge.matched ?? {}), ...Object.keys(judge.partial ?? {})].filter(
    (id) => !ids.has(id),
  );
  if (unknown.length) throw new Error(`judge names ids not in the truth: ${unknown.join(', ')}`);
  const matched = Object.entries(judge.matched ?? {})
    .filter(([, refs]) => refs?.length)
    .map(([id]) => id);
  const blockIds = c.gt.filter((g) => g.block).map((g) => g.id);
  const partial = Object.keys(judge.partial ?? {}).filter((id) => !matched.includes(id));
  const row = {
    date: new Date().toISOString().slice(0, 10),
    label,
    skill,
    matched: matched.length,
    total: c.gt.length,
    recall: +(matched.length / c.gt.length).toFixed(3),
    blocking: matched.filter((id) => blockIds.includes(id)).length,
    blockingTotal: blockIds.length,
    partial: partial.length,
    beyond: (judge.beyond ?? []).length,
    missedBlocking: blockIds.filter((id) => !matched.includes(id)),
  };
  return row;
}

/** review-sync "Found by others" rows → anonymised truth candidates; rows a human marked "not a miss" stay out. */
export function harvest(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^##\s+Found by others\s*$/.test(l));
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) break; // "### General comments" — no position, not a miss
    const m = l.match(/^[-*] @[\w.-]+ · `([^`]+)` · (open|closed) · "(.*)" — \S*#note_(\d+)/);
    if (!m) continue;
    const notes = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++)
      notes.push(lines[j].trim());
    if (notes.some((n) => /not a miss/i.test(n))) continue;
    out.push({
      // no reviewer tag at all: a hash of a handful of colleague names is a name
      where: m[1],
      what: m[3].replace(/@[\w.-]+/g, '@…'),
      note: m[4],
      cls: notes.map((n) => n.replace(/@[\w.-]+/g, '@…')).join(' / '),
    });
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const evals = path.resolve(o.evals ?? path.join(HOME, '.agent', 'evals', 'deep-review'));
  if (cmd === 'list') {
    if (!existsSync(evals)) {
      console.log(`no cases in ${evals}`);
      return 0;
    }
    for (const id of readdirSync(evals).filter((d) =>
      existsSync(path.join(evals, d, 'case.json')),
    )) {
      let c;
      try {
        c = loadCase(evals, id);
      } catch (e) {
        console.log(`${id}: invalid — ${e.message}`);
        continue;
      }
      const last = history(c.dir).at(-1);
      console.log(
        `${id}: ${c.gt.length} items (${c.gt.filter((g) => g.block).length} blocking) · last ${last ? `${last.matched}/${last.total} blocking ${last.blocking}/${last.blockingTotal} «${last.label}» ${last.date}` : 'never run'}`,
      );
    }
    return 0;
  }
  const id = cmd === 'harvest' ? o.case : o._[0];
  if (!id) {
    console.error(
      'usage: review-eval.mjs list | prompt <case> --dir D | judge-prompt <case> --reports a,b | score <case> --judge f --label L | harvest <report> --case C [--write]',
    );
    return 2;
  }
  const c = loadCase(evals, id);
  if (cmd === 'prompt') {
    if (!o.dir) throw new Error('missing --dir (run directory for clone, plan and lane reports)');
    const dir = path.resolve(o.dir);
    mkdirSync(dir, { recursive: true });
    const prep = prepare(c, dir);
    console.log(prep.summary);
    lanePrompts(c, { dir, ...prep }).forEach((p, k) => {
      const f = path.join(dir, `prompt-lane-${prep.lanes[k]}.txt`);
      writeFileSync(f, p);
      console.log(f);
    });
    return 0;
  }
  if (cmd === 'judge-prompt') {
    if (!o.reports) throw new Error('missing --reports a.md,b.md');
    const p = judgePrompt(c, String(o.reports).split(','));
    if (o.out) {
      writeFileSync(o.out, p);
      console.log(o.out);
    } else console.log(p);
    return 0;
  }
  if (cmd === 'score') {
    if (!o.judge || !o.label) throw new Error('missing --judge <file> or --label <text>');
    const prev = history(c.dir).at(-1);
    const row = score(c, JSON.parse(readFileSync(o.judge, 'utf8')), String(o.label));
    appendFileSync(path.join(c.dir, 'history.jsonl'), JSON.stringify(row) + '\n');
    const d = (k) => (prev ? ` (${row[k] - prev[k] >= 0 ? '+' : ''}${row[k] - prev[k]})` : '');
    console.log(
      `${id} «${row.label}» skill ${row.skill}: ${row.matched}/${row.total}${d('matched')} · blocking ${row.blocking}/${row.blockingTotal}${d('blocking')} · partial ${row.partial} · beyond ${row.beyond}${row.missedBlocking.length ? ` · missed blocking ${row.missedBlocking.join(' ')}` : ''}${prev ? ` · vs «${prev.label}» skill ${prev.skill}` : ''}`,
    );
    return 0;
  }
  if (cmd === 'harvest') {
    const report = o._[0];
    if (!report) throw new Error('missing <review.agent.md>');
    const rows = harvest(readFileSync(report, 'utf8'));
    const file = path.join(c.dir, 'candidates.md');
    const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const fresh = rows.filter((r) => !have.includes(`note_${r.note}`));
    const text = fresh.map(
      (r) => `- ? ${r.where} — ${r.what} (note_${r.note})${r.cls ? ` · triage: ${r.cls}` : ''}`,
    );
    if (o.write && text.length)
      appendFileSync(
        file,
        (have
          ? ''
          : `# ${id} — truth candidates from review-sync; triage, then promote to gt.md as \`- <ID> [block] where — what\`\n\n`) +
          text.join('\n') +
          '\n',
      );
    console.log(`${rows.length} rows, ${fresh.length} new${o.write ? ` → ${file}` : ''}`);
    if (!o.write) for (const t of text) console.log(t);
    return 0;
  }
  console.error(`unknown command ${cmd}`);
  return 2;
}

if (process.argv[1]?.endsWith('review-eval.mjs')) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`review-eval: ${e.message}`);
    process.exitCode = 2;
  }
}
