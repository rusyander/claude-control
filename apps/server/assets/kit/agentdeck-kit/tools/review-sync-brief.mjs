#!/usr/bin/env node
// review-sync-brief — review-sync closes the review loop only when someone runs it, and nobody did
// (an audit of 38 real reports: 0 `Thread` lines). At session start in a project whose reports are in
// sync use — a finding with a `Thread` line and Status open|accepted — this starts a detached dry run of
// `review-sync --all` at most once per 24h, and on a later start prints one line when MR authors
// answered our threads or other reviewers opened new ones — not yet in the report, not shown before.
//
//   node <kit>/tools/review-sync-brief.mjs --refresh <reviews-dir>    the background job
//
// `brief(cwd)` is what the kit's SessionStart item (hooks/review-sync-brief.mjs) calls: local files only, never waits on the network, never
// writes a report — recording outcomes is `review-sync --write`, the user's call per project. A network
// or token failure keeps the last good results; a report skipped on HTTP keeps its own.
// Env: REVIEW_SYNC_BRIEF_CACHE (cache dir, default the kit state dir in the system temp); REVIEW_SYNC_TOOL (tests).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseReport } from '../hooks/lib/review-report.mjs';
import { STATE_DIR } from '../hooks/lib/kit-paths.mjs';

const SELF = fileURLToPath(import.meta.url);
const TOOL = process.env.REVIEW_SYNC_TOOL || path.join(path.dirname(SELF), 'review-sync.mjs');
const CACHE_DIR = process.env.REVIEW_SYNC_BRIEF_CACHE || path.join(STATE_DIR, 'review-sync');
const DAY = 864e5;
const LIVE = new Set([null, 'open', 'accepted']); // no Status line reads as open, as in parseReport
const VERDICTS = ['accepted', 'declined', 'deferred', 'unclear'];

/** Does any report hold a synced finding still waiting on the author? No → no network, no cache. */
export function waiting(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.agent.md'));
  } catch {
    return false;
  }
  return names.some((n) => {
    let text;
    try {
      text = readFileSync(path.join(dir, n), 'utf8');
    } catch {
      return false;
    }
    return (
      /\bThread\b/i.test(text) &&
      parseReport(text).findings.some((f) => f.threadUrl && LIVE.has(f.status))
    );
  });
}

/** One cache per project root: two worktrees of one repo share a basename, not a path. */
export function cacheFile(dir) {
  const root = path.resolve(dir, '..', '..');
  const id = createHash('sha1')
    .update(root.toLowerCase().replaceAll('\\', '/'))
    .digest('hex')
    .slice(0, 8);
  const name =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-') || 'root';
  return path.join(CACHE_DIR, `review-sync-${name}-${id}.json`);
}

const load = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
function save(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file); // a reader mid-write sees the old file or the new one, never half of it
}

/**
 * What MR authors and other reviewers said that no report records yet and no earlier line showed —
 * so the first run after `--write` is silent. A thread counts once however many lane reports cover it;
 * an author reply is keyed by its note id, so a second reply is news again.
 */
export function news(cache) {
  const shown = new Set(cache.shown ?? []);
  const all = new Set();
  const flips = new Set();
  const byMr = new Map();
  const bump = (iid, k) => {
    const m = byMr.get(iid) ?? { accepted: 0, declined: 0, deferred: 0, unclear: 0, others: 0 };
    m[k]++;
    byMr.set(iid, m);
  };
  const seen = (fp) => (all.has(fp) ? true : (all.add(fp), false));
  for (const r of Object.values(cache.reports ?? {})) {
    for (const o of r.outcomes ?? []) {
      if (o.flipped) flips.add(o.key);
      if (o.lastReply == null || o.recorded) continue;
      const fp = `r:${o.key}@${o.lastReply}`;
      if (!seen(fp) && !shown.has(fp))
        bump(r.iid, VERDICTS.includes(o.verdict) ? o.verdict : 'unclear');
    }
    for (const x of r.others ?? []) {
      if (x.recorded) continue;
      const fp = `o:${r.iid}:${x.key}`;
      if (!seen(fp) && !shown.has(fp)) bump(r.iid, 'others');
    }
  }
  return { byMr, all: [...all], flips: flips.size };
}

export function line({ byMr, flips }) {
  if (!byMr.size) return null;
  const parts = [...byMr.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([iid, m]) => {
      const answered = VERDICTS.reduce((n, k) => n + m[k], 0);
      const bits = [];
      if (answered)
        bits.push(
          `author answered ${answered} thread(s) (${VERDICTS.filter((k) => m[k])
            .map((k) => `${m[k]} ${k}`)
            .join(', ')})`,
        );
      if (m.others) bits.push(`${m.others} new thread(s) by other reviewers`);
      return `MR !${iid} — ${bits.join('; ')}`;
    });
  const list = parts.length > 4 ? [...parts.slice(0, 4), `+${parts.length - 4} more MR(s)`] : parts;
  return (
    `Review sync: ${list.join('; ')}${flips ? `; ${flips} finding(s) would go open→accepted` : ''}. ` +
    'Mention it to the user. Detail: node <kit>/tools/review-sync.mjs --all (dry run); recording it into the reports is --write — ask the user first.'
  );
}

/** SessionStart line or null. Local files only; a project not read for 24h starts the detached refresh. */
export function brief(cwd = process.cwd(), { spawnRefresh = true, now = Date.now() } = {}) {
  const dir = path.join(cwd, '.agent', 'reviews');
  if (!existsSync(dir) || !waiting(dir)) return null;
  const file = cacheFile(dir);
  const cache = load(file);
  const found = news(cache);
  const out = line(found);
  if (out) cache.shown = found.all;
  const age = now - (cache.attemptAt ?? 0);
  // The attempt is stamped BEFORE the spawn and counts whether it succeeds: offline, a failed run must
  // not turn into a forge read on every session start.
  const stale = spawnRefresh && !(age >= 0 && age < DAY);
  if (stale) cache.attemptAt = now;
  if (out || stale) {
    try {
      save(file, cache);
    } catch {
      return out; // an unsaved stamp would respawn on every start
    }
  }
  if (stale) {
    try {
      spawn(process.execPath, [SELF, '--refresh', dir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      /* tomorrow tries again */
    }
  }
  return out;
}

/** The background job: a dry run over every report, merged into the cache. */
export function refresh(dir, now = Date.now()) {
  const r = spawnSync(process.execPath, [TOOL, '--all', dir, '--json'], {
    encoding: 'utf8',
    timeout: 10 * 6e4,
    maxBuffer: 64 << 20,
    windowsHide: true,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    /* exit 2 (no credentials, token rejected, GitLab unreachable) prints no JSON */
  }
  const file = cacheFile(dir);
  const cache = load(file); // re-read: a brief may have stamped `shown` while the run was going
  if (!Array.isArray(out?.reports)) {
    cache.lastError = `${r.error?.code ?? `exit ${r.status}`}: ${String(r.stderr ?? '')
      .trim()
      .split('\n')[0]
      .slice(0, 200)}`;
  } else {
    const prev = cache.reports ?? {};
    const next = {};
    for (const rep of out.reports) {
      const key = path.basename(rep.file);
      if (!rep.skipped) next[key] = rep;
      else if (rep.hard && prev[key]) next[key] = prev[key];
    }
    const hard = out.reports.filter((x) => x.hard);
    cache.reports = next;
    cache.ranAt = now;
    cache.lastError = hard.length
      ? `${hard.length} report(s) kept from the last run: ${hard[0].skipped}`
      : null;
  }
  save(file, cache);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === '--refresh' &&
  process.argv[3]
) {
  try {
    refresh(path.resolve(process.argv[3]));
  } catch {
    /* tomorrow tries again */
  }
}
