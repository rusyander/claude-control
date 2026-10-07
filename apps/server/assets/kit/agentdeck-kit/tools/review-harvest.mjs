#!/usr/bin/env node
// review-harvest — the learning channel of a code-style profile, read from the forge instead of hoped for.
//
// Calibration on a real team: the profile's last review lesson was a month old; the 148 own MRs since
// carried 172 human notes, ~17 of them style asks after that lesson ("extract a constant", "why
// useCallback here", "use a map instead", a comment the edit had falsified) — none reached the profile. The
// skill's channel was "the user brings the comments"; the user never did, and deep-review read the same
// stale profile as its canon. This lists what human reviewers wrote on MY merge requests since the
// profile last learned, so the lessons are generalised from the source rather than from memory.
//
//   node <kit>/tools/review-harvest.mjs [--profile <code-style-profile.md>] [--since <date|ISO>]
//        [--project grp/proj] [--me user] [--full] [--json]
//
// Window start: --since (a date = its 00:00 UTC, inclusive); else the profile's `Harvested through <ISO>`
// (a date = the whole day already read); else its frontmatter `modified:`; else 30 days back. A note
// counts when it is strictly newer than the start. MRs: authored by --me (default: the token's user),
// updated after the start, any state. Notes: every non-system note by a human other than me — replies
// in my threads included (↳), bots excluded. Project: --project, else the `origin` remote of the cwd.
//
// GET only — nothing is written anywhere; folding the remarks into the profile is the model's job, and
// so is writing the printed watermark into the profile header. The watermark is printed ONLY when every
// MR was read in full: a partial harvest that advanced it would lose the unread notes for good.
// Exit: 0 ok (zero remarks included) · 1 an MR could not be read · 2 no credentials / user / project.
import { readFileSync, existsSync } from 'node:fs';
import { secrets, get, getAll, originProject, scrub, BOT } from './lib/gitlab.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = flag('--json');
const FULL = flag('--full');
const DAY = 864e5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function windowStart(now) {
  const since = opt('--since');
  if (since) {
    const t = Date.parse(DATE.test(since) ? `${since}T00:00:00Z` : since);
    return Number.isNaN(t)
      ? { error: `--since is not a date: ${since}` }
      : { t: t - 1, source: '--since' };
  }
  const file = opt('--profile');
  if (file) {
    if (!existsSync(file)) return { error: `no profile: ${file}` };
    const text = readFileSync(file, 'utf8');
    const mark = text.match(/Harvested through (\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/)?.[1];
    if (mark)
      return {
        t: DATE.test(mark) ? Date.parse(`${mark}T00:00:00Z`) + DAY - 1 : Date.parse(mark),
        source: 'profile watermark',
      };
    const modified = text.match(/^\s*modified:\s*['"]?(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/m)?.[1];
    if (modified)
      return {
        t: Date.parse(DATE.test(modified) ? `${modified}T00:00:00Z` : modified),
        source: 'profile modified',
      };
  }
  return { t: now - 30 * DAY, source: 'default 30 days' };
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const excerpt = (s, n = 160) => {
  const t = oneLine(s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

async function main() {
  const now = Date.now();
  const start = windowStart(now);
  if (start.error) {
    console.error(`review-harvest: ${start.error}`);
    return 2;
  }
  const project = opt('--project') || originProject(process.cwd());
  if (!project) {
    console.error('review-harvest: no project — pass --project grp/proj or run inside the repo');
    return 2;
  }
  const cred = secrets();
  if (cred.error) {
    console.error(`review-harvest: ${cred.error}`);
    return 2;
  }
  let me = opt('--me');
  try {
    me ||= (await get(cred, `${cred.api}/user`)).body?.username;
  } catch (e) {
    console.error(`review-harvest: ${e.message}`);
    return 2;
  }
  if (!me) {
    console.error('review-harvest: cannot resolve the current user; pass --me <username>');
    return 2;
  }

  const base = `${cred.api}/projects/${encodeURIComponent(project)}`;
  const sinceIso = new Date(start.t).toISOString();
  let mrs;
  try {
    mrs = await getAll(
      cred,
      `${base}/merge_requests?author_username=${encodeURIComponent(me)}&updated_after=${sinceIso}&state=all&scope=all`,
    );
  } catch (e) {
    console.error(`review-harvest: ${e.message}`);
    return 2;
  }

  const remarks = [];
  const failed = [];
  for (const mr of mrs) {
    let discussions;
    try {
      discussions = await getAll(cred, `${base}/merge_requests/${mr.iid}/discussions`);
    } catch (e) {
      failed.push(`!${mr.iid}: ${e.message}`);
      continue;
    }
    for (const d of discussions) {
      (d.notes ?? []).forEach((n, i) => {
        const who = n.author?.username ?? '';
        if (n.system || !who || who === me || BOT.test(who) || n.author?.bot) return;
        if (!(Date.parse(n.created_at) > start.t) || !oneLine(n.body)) return;
        const p = n.position;
        remarks.push({
          at: n.created_at,
          iid: mr.iid,
          author: who,
          path: p ? p.new_path || p.old_path || null : null,
          line: p ? (p.new_line ?? p.old_line ?? null) : null,
          reply: i > 0,
          resolved: Boolean(d.notes[0]?.resolved),
          body: FULL ? oneLine(n.body) : excerpt(n.body),
          url: `${mr.web_url}#note_${n.id}`,
        });
      });
    }
  }
  remarks.sort((a, b) => a.at.localeCompare(b.at) || a.iid - b.iid);
  const watermark = failed.length ? null : new Date(now).toISOString();

  if (JSON_OUT) {
    console.log(
      JSON.stringify({
        project,
        me,
        since: sinceIso,
        sinceSource: start.source,
        watermark,
        mrs: mrs.length,
        failed,
        remarks,
      }),
    );
  } else {
    const by = {};
    for (const r of remarks) by[r.author] = (by[r.author] ?? 0) + 1;
    const who = Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([u, c]) => `${u} ${c}`)
      .join(', ');
    console.log(
      `review-harvest ${project} · me ${me} · since ${sinceIso} (${start.source}) · MRs ${mrs.length} · remarks ${remarks.length}${who ? ` (${who})` : ''}`,
    );
    for (const r of remarks) {
      const where = r.path ? `${r.path}${r.line != null ? `:${r.line}` : ''}` : 'general';
      console.log(
        `${r.at.slice(0, 10)} !${r.iid} @${r.author}${r.reply ? ' ↳' : ''} ${where}${r.resolved ? ' [resolved]' : ''} «${r.body}» ${r.url}`,
      );
    }
    for (const f of failed) console.log(`UNREAD ${scrub(f)}`);
    console.log(
      watermark
        ? `watermark: Harvested through ${watermark} — write it into the profile header once these are folded in`
        : `watermark: none — ${failed.length} MR(s) unread; fix access and re-run before advancing the profile`,
    );
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
