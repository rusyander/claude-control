#!/usr/bin/env node
// Lane plan and coverage ledger for deep-review. Measured on a real ~460-file MR (blind run, 2 lanes):
// each lane stopped at ~100 tool calls / ~12 min whatever its time budget, with half its zone unread,
// and the second round on the unread files added 25 findings (10 of the colleagues' 55). Coverage is
// therefore planned and checked by this tool, never promised in prose.
//
//   node review-plan.mjs plan  --base <sha> [--head <sha>] [--repo <dir>] [--paths a,b] [--out <dir>]
//                              [--chunk 400] [--per-round 5] [--max-rounds 6] [--lanes 2|4] [--exclude re,…]
//   node review-plan.mjs check --plan <dir>/plan.json <lane-report.md>…
//   node review-plan.mjs estimate --n1 <A> --n2 <B> --m <shared>
//
// plan  — changed files → zones → chunks of ≤--chunk changed lines → lanes → rounds. Fleet:
//         ≤100 files → 2 lanes, >100 → 4; more than --max-rounds rounds → ASK with the lane
//         count that fits. Writes plan.json + plan.md; prints one summary line.
// check — every planned file needs a ledger row in some lane report: a line holding its repo path (or a
//         `dir/*` glob covering it) and a status word. Prints the `**Ledger:**` line and, per lane, the
//         chunks to rerun. Exit 1 while a file has no row.
// estimate — Chapman capture-recapture over two independent readers: remaining ≈ N̂ − union.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LANES2 = [
  { id: 'A', artifacts: 'CONSUMER + SPEC', order: 'forward' },
  { id: 'B', artifacts: 'TEST + AUTHZ', order: 'reverse' },
];
const DEFAULT_EXCLUDE = [
  /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|__snapshots__)\//,
  /\.(min\.js|min\.css|map|snap|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|poetry\.lock|Cargo\.lock|uv\.lock|composer\.lock)$/,
  /\.pb\.go$|_pb2\.py$|\.gen\.|_gen\.go$|(^|\/)generated\//i,
];
const STATUS = /\b(read|swept|n\/a|skipped-generated)\b/i;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function git(repo, ...a) {
  const r = spawnSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Hunk ranges of one file on the head side, from `git diff -U0`. */
function hunks(repo, base, head, file) {
  const out = [];
  for (const m of git(repo, 'diff', '-U0', '-M', base, head, '--', file).matchAll(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    const del = m[2] === undefined ? 1 : +m[2];
    const add = m[4] === undefined ? 1 : +m[4];
    out.push({ from: +m[3], to: +m[3] + Math.max(add, 1) - 1, lines: add + del });
  }
  return out;
}

/** A hunk longer than the cap (a new file is one hunk) is cut into consecutive head-line ranges. */
function cut(h, max) {
  if (h.lines <= max || h.to <= h.from) return [h];
  const out = [];
  for (let from = h.from; from <= h.to; from += max)
    out.push({ from, to: Math.min(h.to, from + max - 1), lines: Math.min(max, h.to - from + 1) });
  return out;
}

export function plan(o) {
  const repo = path.resolve(o.repo ?? '.');
  const head = o.head ?? 'HEAD';
  const chunkMax = +(o.chunk ?? 400);
  const perRound = +(o['per-round'] ?? 5);
  const maxRounds = +(o['max-rounds'] ?? 6);
  const paths = o.paths
    ? String(o.paths)
        .split(',')
        .map((p) => p.trim().replace(/\/$/, ''))
        .filter(Boolean)
    : [];
  const exclude = [
    ...DEFAULT_EXCLUDE,
    ...(o.exclude
      ? String(o.exclude)
          .split(',')
          .map((r) => new RegExp(r))
      : []),
  ];
  const raw = git(repo, 'diff', '--numstat', '-M', o.base, head, '--', ...paths);
  const files = [];
  const excluded = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t');
    let file = rest.join('\t');
    const ren = file.match(/^(.*)\{(.*) => (.*)\}(.*)$/); // a/{x => y}/b
    if (ren) file = `${ren[1]}${ren[3]}${ren[4]}`.replace(/\/\//g, '/');
    else if (file.includes(' => ')) file = file.split(' => ')[1];
    if (a === '-' || exclude.some((re) => re.test(file))) {
      excluded.push(file);
      continue;
    }
    const zone =
      paths.find((p) => file === p || file.startsWith(p + '/')) ??
      (file.includes('/') ? file.split('/')[0] : '.');
    files.push({ path: file, zone, lines: +a + +d });
  }
  files.sort((x, y) => x.zone.localeCompare(y.zone) || x.path.localeCompare(y.path));

  // Chunks: files kept whole and in path order inside a zone; a file over the cap is cut at hunk seams.
  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur?.items.length) chunks.push(cur);
    cur = null;
  };
  const open = (zone) => {
    cur = { id: `c${String(chunks.length + 1).padStart(3, '0')}`, zone, lines: 0, items: [] };
  };
  for (const f of files) {
    if (cur && (cur.zone !== f.zone || cur.lines + f.lines > chunkMax)) flush();
    if (f.lines > chunkMax) {
      flush();
      const hs = hunks(repo, o.base, head, f.path).flatMap((h) => cut(h, chunkMax));
      let part = { from: null, to: null, lines: 0 };
      const parts = [];
      for (const h of hs) {
        if (part.lines && part.lines + h.lines > chunkMax) {
          parts.push(part);
          part = { from: null, to: null, lines: 0 };
        }
        part.from ??= h.from;
        part.to = h.to;
        part.lines += h.lines;
      }
      if (part.lines) parts.push(part);
      for (const p of parts.length ? parts : [{ from: 1, to: null, lines: f.lines }]) {
        open(f.zone);
        cur.items.push({ path: f.path, from: p.from, to: p.to });
        cur.lines = p.lines;
        flush();
      }
      continue;
    }
    if (!cur) open(f.zone);
    cur.items.push({ path: f.path });
    cur.lines += f.lines;
  }
  flush();

  // Fleet: ≤100 files → 2 lanes, >100 → 4, beyond that the user is asked.
  const laneCount = +(o.lanes ?? (files.length > 100 ? 4 : 2));
  const lanes = [];
  if (laneCount <= 2) {
    const ids = chunks.map((c) => c.id);
    for (const l of LANES2)
      lanes.push({ ...l, group: 1, chunks: l.order === 'reverse' ? [...ids].reverse() : ids });
  } else {
    // Two groups balanced by changed lines, zones kept whole; one zone only → split its chunks in halves.
    const byZone = new Map();
    for (const c of chunks) byZone.set(c.zone, [...(byZone.get(c.zone) ?? []), c]);
    const groups = [
      { lines: 0, ids: [] },
      { lines: 0, ids: [] },
    ];
    if (byZone.size >= 2) {
      const zones = [...byZone.values()].sort(
        (a, b) => b.reduce((s, c) => s + c.lines, 0) - a.reduce((s, c) => s + c.lines, 0),
      );
      for (const z of zones) {
        const g = groups[0].lines <= groups[1].lines ? groups[0] : groups[1];
        g.ids.push(...z.map((c) => c.id));
        g.lines += z.reduce((s, c) => s + c.lines, 0);
      }
    } else {
      const half = Math.ceil(chunks.length / 2);
      groups[0].ids = chunks.slice(0, half).map((c) => c.id);
      groups[1].ids = chunks.slice(half).map((c) => c.id);
    }
    groups.forEach((g, gi) => {
      for (const l of LANES2)
        lanes.push({
          ...l,
          id: `${l.id}${gi + 1}`,
          group: gi + 1,
          chunks: l.order === 'reverse' ? [...g.ids].reverse() : g.ids,
        });
    });
  }
  for (const l of lanes) {
    l.rounds = [];
    for (let i = 0; i < l.chunks.length; i += perRound)
      l.rounds.push(l.chunks.slice(i, i + perRound));
  }
  const rounds = Math.max(0, ...lanes.map((l) => l.rounds.length));
  const perLaneChunks = Math.max(0, ...lanes.map((l) => l.chunks.length));
  const ask = rounds > maxRounds;
  // Lanes needed to fit maxRounds, in pairs (each chunk keeps two readers with different artifacts).
  const recommend = ask
    ? 2 * Math.ceil((laneCount / 2) * (perLaneChunks / (perRound * maxRounds)))
    : laneCount;
  const lineTotal = files.reduce((s, f) => s + f.lines, 0);
  // The spawn announcement names this fleet: planned rounds + 1 reserve for
  // RERUN chunks; spawn-cost-guard passes exactly it. The ASK variant fits maxRounds with more lanes.
  const verifiers = 4;
  const grant = { rounds: rounds + 1, agents: lanes.length, verifiers };
  const alt = ask
    ? {
        rounds: Math.ceil(Math.ceil((perLaneChunks * laneCount) / recommend) / perRound) + 1,
        agents: recommend,
        verifiers,
      }
    : null;
  const grantLine = (g) => `${g.rounds} rounds × ${g.agents} agents + ≤${g.verifiers} verifiers`;
  return {
    repo,
    base: o.base,
    head,
    paths,
    chunkMax,
    perRound,
    maxRounds,
    files: files.map((f) => f.path),
    excluded,
    lines: lineTotal,
    chunks,
    lanes,
    rounds,
    ask,
    recommend,
    grant,
    grantAlt: alt,
    summary:
      `plan: ${files.length} files (${excluded.length} excluded), ${lineTotal} changed lines, ${chunks.length} chunks, lanes ${lanes.length}, rounds ${rounds}` +
      (ask ? ` — ASK: ${rounds} rounds > ${maxRounds}; ${recommend} lanes fit ${maxRounds}` : '') +
      `\ngrant: ${grantLine(grant)}` +
      (alt ? `\ngrant (ASK variant): ${grantLine(alt)}` : ''),
  };
}

function planMd(p) {
  const byId = new Map(p.chunks.map((c) => [c.id, c]));
  const out = [`# Lane plan — ${p.base}..${p.head}`, '', p.summary, ''];
  for (const l of p.lanes) {
    out.push(`## Lane ${l.id} — ${l.artifacts} (group ${l.group}, ${l.order})`, '');
    l.rounds.forEach((r, i) => {
      out.push(`### Round ${i + 1}`);
      for (const id of r) {
        const c = byId.get(id);
        out.push(
          `- ${id} (${c.zone}, ${c.lines} lines): ${c.items.map((it) => (it.from ? `${it.path}:${it.from}-${it.to ?? ''}` : it.path)).join(' · ')}`,
        );
      }
      out.push('');
    });
  }
  if (p.excluded.length)
    out.push(
      '## Excluded (generated, binary, lockfiles)',
      '',
      ...p.excluded.map((f) => `- ${f}`),
      '',
    );
  return out.join('\n');
}

/** Files with a ledger row: a line naming the path (or a covering `dir/*` glob) plus a status word. */
export function check(p, texts) {
  const rows = texts.flatMap((t) => t.split(/\r?\n/)).filter((l) => STATUS.test(l));
  const globs = [];
  for (const l of rows)
    for (const m of l.matchAll(/([\w.@~/-]+)\/\*{1,2}/g)) globs.push(m[1] + '/');
  const joined = rows.join('\n');
  const covered = new Set();
  for (const f of p.files) {
    if (joined.includes(f) || globs.some((g) => f.startsWith(g))) covered.add(f);
  }
  const missing = p.files.filter((f) => !covered.has(f));
  const chunkOf = new Map();
  for (const c of p.chunks)
    for (const it of c.items) chunkOf.set(it.path, [...(chunkOf.get(it.path) ?? []), c.id]);
  const rerun = {};
  const miss = new Set(missing.flatMap((f) => chunkOf.get(f) ?? []));
  for (const l of p.lanes) {
    const ids = l.chunks.filter((id) => miss.has(id));
    if (ids.length) rerun[l.id] = ids;
  }
  const journal = `**Ledger:** ${covered.size}/${p.files.length} files · lanes ${p.lanes.length} · rounds ${p.rounds}`;
  return { covered: covered.size, planned: p.files.length, missing, rerun, journal };
}

/** Chapman estimator: N̂ = (n1+1)(n2+1)/(m+1) − 1; remaining = N̂ − union. */
export function estimate(n1, n2, m) {
  const total = ((n1 + 1) * (n2 + 1)) / (m + 1) - 1;
  const union = n1 + n2 - m;
  return {
    total: Math.round(total * 10) / 10,
    union,
    remaining: Math.max(0, Math.round((total - union) * 10) / 10),
  };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (cmd === 'plan') {
    if (!o.base) throw new Error('plan needs --base <sha>');
    const p = plan(o);
    const out = path.resolve(o.out ?? '.');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'plan.json'), JSON.stringify(p, null, 1));
    writeFileSync(path.join(out, 'plan.md'), planMd(p));
    console.log(p.summary);
    console.log(`→ ${path.join(out, 'plan.md')}`);
    return 0;
  }
  if (cmd === 'check') {
    const p = JSON.parse(readFileSync(o.plan, 'utf8'));
    const r = check(
      p,
      o._.map((f) => readFileSync(f, 'utf8')),
    );
    console.log(r.journal);
    for (const [lane, ids] of Object.entries(r.rerun))
      console.log(`RERUN lane ${lane}: ${ids.join(' ')}`);
    if (r.missing.length) {
      console.log(`no ledger row (${r.missing.length}):`);
      for (const f of r.missing.slice(0, 40)) console.log(`  ${f}`);
      if (r.missing.length > 40) console.log(`  … +${r.missing.length - 40}`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'estimate') {
    const e = estimate(+o.n1, +o.n2, +o.m);
    console.log(
      `estimate: total ≈${e.total}, found ${e.union}, remaining ≈${e.remaining}` +
        (e.remaining > 0.2 * e.union ? ' — another round is worth it' : ''),
    );
    return 0;
  }
  console.error(
    'usage: review-plan.mjs plan --base <sha> [...] | check --plan plan.json <lane.md>… | estimate --n1 A --n2 B --m C',
  );
  return 2;
}

if (
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` ||
  process.argv[1]?.endsWith('review-plan.mjs')
) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`review-plan: ${e.message}`);
    process.exitCode = 2;
  }
}
