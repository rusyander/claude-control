#!/usr/bin/env node
// Builds the inline `position` of a review thread — the one a finding on a RANGE of lines needs.
//
//   node review-position.mjs --file <path> --lines 10-14 --base-sha <sha> --start-sha <sha> --head-sha <sha>
//        [--repo <dir>] [--side new|old] [--old-path <path>]
//
// base/start/head come from `list_merge_request_versions` (base_commit_sha, start_commit_sha,
// head_commit_sha). A multi-line finding is ONE thread on the range (MR !988: threads were pinned to a
// single line and the range sat in the text; the owner wants the range selected in the diff):
//   GitLab `position.line_range.{start,end}` with `line_code` = `<sha1(new_path)>_<old>_<new>` as GitLab
//   itself computes it for a diff line (old/new = the line counters at that line: for an added line `old` is
//   the NEXT old line, never empty), `type` = `new` for an added line, otherwise `old`; and the position's own
//   `new_line`/`old_line` = the END line. One line → the plain position, no `line_range`.
// Output: the position object as JSON, ready for create_merge_request_thread / create_draft_note, plus a
// `github` block (`path`, `start_line`, `line`, `side`) for a GitHub review comment.
// Exit 2 = bad usage / file not in the diff / line past the end of the file; 3 = the range is outside the
// diff (GitLab accepts a thread only on a hunk or its 3 lines of context — it goes to the summary note's
// «вне диффа» section instead).
//
// Not verified against a live GitLab (no instance here): the shape follows the REST docs and the counters
// follow GitLab's diff parser; a refused thread is reported by the API, never swallowed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CONTEXT = 3;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function git(repo, ...a) {
  const r = spawnSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

/** `@@ -a,b +c,d @@` hunks of a `-U0` diff: `{a,b,c,d}` (omitted counts are 1). */
export function parseHunks(diff) {
  const hunks = [];
  for (const l of String(diff).split('\n')) {
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m)
      hunks.push({
        a: +m[1],
        b: m[2] === undefined ? 1 : +m[2],
        c: +m[3],
        d: m[4] === undefined ? 1 : +m[4],
      });
  }
  return hunks;
}

/**
 * What the diff says about line `n` on the given side:
 *   { kind: 'added'|'removed'|'context', old, new, shown } — `old`/`new` are GitLab's counters for that line
 *   (an added line carries the next old line; a removed one the next new line), `shown` = on screen in a
 *   diff with 3 lines of context.
 */
export function classify(hunks, n, side = 'new') {
  const sorted = [...hunks].sort((x, y) => x.a - y.a);
  if (side === 'new') {
    let delta = 0;
    for (const h of sorted) {
      if (h.d > 0 && n >= h.c && n < h.c + h.d)
        return { kind: 'added', old: h.b === 0 ? h.a + 1 : h.a + h.b, new: n, shown: true };
      if (h.d === 0 ? h.c < n : h.c + h.d <= n) delta += h.d - h.b;
    }
    const near = sorted.some((h) =>
      h.d === 0
        ? n >= h.c - CONTEXT + 1 && n <= h.c + CONTEXT
        : n >= h.c - CONTEXT && n < h.c + h.d + CONTEXT,
    );
    return { kind: 'context', old: n - delta, new: n, shown: near };
  }
  let delta = 0;
  for (const h of sorted) {
    if (h.b > 0 && n >= h.a && n < h.a + h.b)
      return { kind: 'removed', old: n, new: h.d === 0 ? h.c + 1 : h.c, shown: true };
    if (h.b === 0 ? h.a < n : h.a + h.b <= n) delta += h.b - h.d;
  }
  const near = sorted.some((h) =>
    h.b === 0
      ? n >= h.a - CONTEXT + 1 && n <= h.a + CONTEXT
      : n >= h.a - CONTEXT && n < h.a + h.b + CONTEXT,
  );
  return { kind: 'context', old: n, new: n - delta, shown: near };
}

const lineCode = (file, old, now) =>
  `${createHash('sha1').update(file).digest('hex')}_${old}_${now}`;

/** The `line_range` end of one line. */
function endpoint(file, c) {
  const isNew = c.kind === 'added';
  return {
    line_code: lineCode(file, c.old, c.new),
    type: isNew ? 'new' : 'old',
    old_line: isNew ? null : c.old,
    new_line: c.kind === 'removed' ? null : c.new,
  };
}

/**
 * The position for lines `start..end` of `file`. `hunks` = parsed `-U0` diff of the file. Returns
 * `{ position, github, warnings }`; throws `Error` with `.code` 2 or 3.
 */
export function buildPosition({
  file,
  oldPath = file,
  start,
  end,
  side = 'new',
  hunks,
  shas,
  length,
}) {
  if (!(start >= 1 && end >= start))
    throw Object.assign(new Error(`bad --lines ${start}-${end}`), { code: 2 });
  if (side === 'new' && length != null && end > length)
    throw Object.assign(
      new Error(`${file} has ${length} lines at head, the range ends at ${end}`),
      { code: 2 },
    );
  const first = classify(hunks, start, side);
  const last = classify(hunks, end, side);
  if (!first.shown || !last.shown) {
    const lines = [first, last].map((c, k) => (c.shown ? null : [start, end][k])).filter(Boolean);
    throw Object.assign(
      new Error(
        `line ${lines.join(', ')} of ${file} is not in the diff (a thread sits only on a changed line or its ${CONTEXT} lines of context) — report it in the summary note's "outside the diff" section`,
      ),
      { code: 3 },
    );
  }
  const codeFile = side === 'old' ? oldPath : file;
  const e = endpoint(codeFile, last);
  const position = {
    base_sha: shas.base,
    start_sha: shas.start,
    head_sha: shas.head,
    position_type: 'text',
    old_path: oldPath,
    new_path: file,
    new_line: e.new_line,
    old_line: e.old_line,
  };
  if (end > start) position.line_range = { start: endpoint(codeFile, first), end: e };
  return {
    position,
    github: {
      path: file,
      ...(end > start ? { start_line: start } : {}),
      line: end,
      side: side === 'old' ? 'LEFT' : 'RIGHT',
    },
    warnings:
      first.kind !== last.kind || (first.kind === 'context') !== (last.kind === 'context')
        ? ['the range mixes changed and unchanged lines — fine for GitLab, check the highlight']
        : [],
  };
}

function main() {
  const o = args(process.argv.slice(2));
  o['base-sha'] ??= o.base;
  o['head-sha'] ??= o.head;
  o['start-sha'] ??= o.start;
  const fail = (msg, code = 2) => {
    console.error(`review-position: ${msg}`);
    return code;
  };
  if (!o.file || !o.lines || !o['base-sha'] || !o['head-sha']) {
    return fail(
      'usage: --file <path> --lines <n|n-m> --base-sha <sha> --start-sha <sha> --head-sha <sha> [--repo dir] [--side new|old] [--old-path path]',
    );
  }
  const m = String(o.lines).match(/^(\d+)(?:[-–](\d+))?$/);
  if (!m) return fail(`--lines wants N or N-M, got "${o.lines}"`);
  const start = +m[1];
  const end = m[2] ? +m[2] : start;
  const repo = path.resolve(o.repo ?? '.');
  const file = String(o.file).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = o['base-sha'];
  const head = o['head-sha'];
  for (const rev of [base, head])
    if (git(repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`) === null)
      return fail(`${rev} is not a commit in ${repo}`);

  // The old path: a rename is visible only in the whole-diff status, not under a pathspec of the new name.
  let oldPath = o['old-path'] ? String(o['old-path']).replace(/\\/g, '/') : file;
  if (!o['old-path']) {
    for (const row of (git(repo, 'diff', '--name-status', '-z', '-M', base, head) ?? '')
      .split('\0')
      .reduce((acc, t, k, all) => {
        if (/^R\d*$/.test(t)) acc.push([all[k + 1], all[k + 2]]);
        return acc;
      }, []))
      if (row[1] === file) oldPath = row[0];
  }
  const diff = git(
    repo,
    'diff',
    '-U0',
    '-M',
    base,
    head,
    '--',
    file,
    ...(oldPath === file ? [] : [oldPath]),
  );
  if (diff === null) return fail('git diff failed');
  const hunks = parseHunks(diff);
  if (!hunks.length)
    return fail(
      `${file} has no hunks in ${base}..${head} — not part of the diff (a binary file or an unchanged path)`,
    );
  const body = git(repo, 'show', `${head}:${file}`);
  try {
    const r = buildPosition({
      file,
      oldPath,
      start,
      end,
      side: o.side === 'old' ? 'old' : 'new',
      hunks,
      shas: { base, start: o['start-sha'] ?? base, head },
      length: body === null ? null : body.split('\n').length - (body.endsWith('\n') ? 1 : 0),
    });
    for (const w of r.warnings) console.error(`review-position: ${w}`);
    console.log(JSON.stringify({ position: r.position, github: r.github }, null, 2));
    return 0;
  } catch (e) {
    return fail(e.message, e.code ?? 2);
  }
}

if (process.argv[1]?.endsWith('review-position.mjs')) process.exitCode = main();
