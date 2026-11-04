#!/usr/bin/env node
// review-sync — closes the loop a published deep-review never closed on its own.
//
// Audit of 38 real reports: 481 findings, 74% still `open`, 0 `Thread` lines, 0 rejected — the
// outcome of every published finding lived only in GitLab, so `published`/`confirmed` were never
// computed and nothing learned from what humans found instead. This reads the MR threads back
// (GET only, never a write to GitLab) and writes the outcome into the report.
//
// An adversarial review, run against the live threads of 23 merged MRs: a finding's block ran
// to EOF, so edits landed in the NEXT finding; greedy ±3-line position matching pinned a 🔴 blocker's
// thread to a 🟡; this team's merge gate resolves every thread, so "resolved" carries no signal; and
// `fixed` written on a regex contradicted the skill's own rule (fixed = the evidence re-ran). Now:
//   - `- **Thread:** <url>` per finding matched to one of OUR threads: the link already in the file wins,
//     then the LEADING `F-NN` of the body (else its only one), then a unique bold thesis, then the diff
//     position — nearest first over all pairs, within 15 lines, severity agreeing; a tie pairs nothing
//     and is printed. A body led by an id foreign to this report (another lane's) is left alone.
//   - `- **Synced:** <date> — …` per matched finding: the MR AUTHOR's last reply, `>` quotes stripped,
//     classified whole (accepted / declined / deferred / unclear); a sha in it checked against the MR.
//   - `Status` open → `accepted` (author agreed, unverified) on an accepting reply only — never on
//     silence, never for ❓, never on a closed MR, never `fixed` (handoff.md §After the author replies).
//   - `## Found by others` — other reviewers' threads opened after our first note that we never answered:
//     candidates to classify. Rows are keyed by `#note_N`, so annotations survive a re-run. Written into
//     one report per MR (not a `-lane-` file); none when the MR is our own.
//   - `- **Synced:** <date> — addressed by <sha7> (lines changed)` — the implicit verdict: a commit after
//     the reviewed head changed lines within ±3 of the finding's `Where` site, computed from local git
//     (see "implicit verdict" below). `Status` is never touched by it.
//   - calibration per report and in total: published · accepted (reply) · addressed (commit) · declined ·
//     other · silent, precision = (accepted+addressed)/published, the silent share printed beside it.
//
//   node <kit>/tools/review-sync.mjs <report.agent.md> [--mr N] [--project grp/proj] [--me user] [--write]
//   node <kit>/tools/review-sync.mjs --all [<reviews-dir>] [--write]     calibration over every MR report
//   … --json   one JSON object on stdout instead of the text (review-sync-brief's background run)
//   … --offline   no forge call: commit verdicts from local git, reply verdicts as recorded
//   … --head <sha> / --ref <ref> / --repo <dir>   single report: override the reviewed head, the branch tip, the repo
//
// Without --write nothing changes on disk. MR iid: --mr, else `MR !N` in the H1, else `mr-N` in the file
// name; a file with no `## F-NN` finding is not a review and is skipped. Project: --project, else the
// `origin` remote of the repo holding the report. Transport: the user's own `glab` login (GET only,
// lib/gitlab.mjs) — no token is read or held here. Exit: 0 ok · 1 a report skipped on an
// HTTP/network failure · 2 forge not connected / no user.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport } from '../hooks/lib/review-report.mjs';
import { scrub, HttpError, BOT, secrets, get, getAll, originProject } from './lib/gitlab.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VALUED = new Set(['--mr', '--project', '--me', '--head', '--ref', '--repo']);
const OFFLINE = flag('--offline');
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const WRITE = flag('--write');
const ALL = flag('--all');
const JSON_OUT = flag('--json');
const say = (s) => JSON_OUT || console.log(s);
// The local date: a sync at 00:11 on the 23rd is the 23rd's, whatever UTC says.
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4)
  .toISOString()
  .slice(0, 10);
const WINDOW = 15; // lines between a thread's position and the cited range (live misses: 5, 11, 12, 24, 25)

// ---------- report ----------
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[`*_«»"'.,:;!?()—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function mrIid(text, file) {
  return (
    opt('--mr') ||
    text.match(/^#\s.*?\bMR\s*!(\d+)/m)?.[1] ||
    path.basename(file).match(/\bmr-(\d+)/i)?.[1] ||
    null
  );
}

function projectOf(file) {
  return opt('--project') || originProject(path.dirname(path.resolve(file)));
}

// ---------- matching ----------
const ID = /(?<![\w-])F-\d+(?!\d)/g;
const idsIn = (body) => [...new Set([...String(body).matchAll(ID)].map((m) => m[0]))];
// The id a body LEADS with: `F-93 (see F-97, F-98): …`, `**F-131 🟡 …`, `🟡 **F-02** …`.
const leadId = (body) => String(body).match(/^[^\p{L}\p{N}]*(F-\d+)(?!\d)/u)?.[1] ?? null;
const leadSeverity = (body) =>
  String(body)
    .slice(0, 80)
    .match(/[🔴🟡🟢❓]/u)?.[0] ?? null;

// A path as cited: `.../` or `…/` elides the head, `{a,b}` names alternatives. Compared on the last
// 1-3 components, never on the literal — `inst-admin-ui/.../ChatTestPanel/x.tsx` hid a 🔴 blocker.
const expand = (p) => {
  const m = p.match(/\{([^{}]*)\}/);
  return m ? m[1].split(',').flatMap((alt) => expand(p.replace(m[0], alt))) : [p];
};
function sameFile(real, cited) {
  const r = real.split('/').filter(Boolean);
  return expand(cited).some((c) => {
    const parts = c.split('/').filter(Boolean);
    const tail = parts.slice(parts.findLastIndex((s) => /^(?:\.{2,}|…)$/.test(s)) + 1);
    const k = Math.min(3, tail.length, r.length);
    return k > 0 && tail.slice(-k).join('/') === r.slice(-k).join('/');
  });
}

function match(findings, discussions, me) {
  const ours = discussions.filter((d) => !d.notes[0].system && d.notes[0].author?.username === me);
  const known = new Set(findings.map((f) => f.id));
  const foreign = (d) => {
    const lead = leadId(d.notes[0].body);
    return lead != null && !known.has(lead);
  };
  const taken = new Set();
  const pairs = new Map(); // finding id → discussion
  const blocked = new Set(); // findings that must not pair by a weaker pass
  const ties = [];
  const linkMissing = [];
  const pair = (f, d) => {
    pairs.set(f.id, d);
    taken.add(d.id);
  };
  const pass = (pick) => {
    for (const d of ours) {
      if (taken.has(d.id) || foreign(d)) continue;
      const f = pick(d);
      if (f && !pairs.has(f.id) && !blocked.has(f.id)) pair(f, d);
    }
  };
  // 0. The link already in the file — written by an earlier sync or by hand at publish time.
  for (const f of findings) {
    const note = f.threadUrl?.match(/#note_(\d+)/)?.[1];
    if (!note) continue;
    const d = discussions.find(
      (x) => !taken.has(x.id) && x.notes.some((n) => String(n.id) === note),
    );
    if (d) pair(f, d);
    else {
      blocked.add(f.id);
      linkMissing.push(`${f.id}: note_${note}`);
    }
  }
  // 1. The id the body leads with, else its only id.
  pass((d) => {
    const ids = idsIn(d.notes[0].body);
    const id = leadId(d.notes[0].body) ?? (ids.length === 1 ? ids[0] : null);
    return findings.find((f) => f.id === id) ?? null;
  });
  // 2. The bold thesis (first **…** of the body) against exactly one heading.
  pass((d) => {
    const bold = norm(String(d.notes[0].body).match(/\*\*(.+?)\*\*/s)?.[1]);
    if (bold.length < 20) return null;
    const hits = findings.filter((f) => {
      const t = norm(f.thesis);
      return t.length >= 20 && (t.includes(bold) || bold.includes(t));
    });
    return hits.length === 1 ? hits[0] : null;
  });
  // 3. The diff position against `Where`, over all pairs at once: nearest first; equal distance on a
  //    shared thread or finding is a tie — both sides stay unpaired and are printed for a human.
  const cands = [];
  for (const d of ours) {
    if (taken.has(d.id) || foreign(d)) continue;
    const p = d.notes[0].position;
    const file = p?.new_path || p?.old_path;
    if (!file) continue;
    const line = p.new_line ?? p.old_line ?? null; // null: a file-level thread, the weakest match
    const sev = leadSeverity(d.notes[0].body);
    for (const f of findings) {
      if (pairs.has(f.id) || blocked.has(f.id) || (sev && f.severity && sev !== f.severity))
        continue;
      let best = null;
      for (const l of f.locs) {
        if (!sameFile(file, l.file)) continue;
        const dist =
          line == null ? WINDOW : line < l.from ? l.from - line : line > l.to ? line - l.to : 0;
        if (dist <= WINDOW && (best == null || dist < best)) best = dist;
      }
      if (best != null) cands.push({ d, f, dist: best });
    }
  }
  cands.sort((a, b) => a.dist - b.dist);
  const usedF = new Set();
  for (let i = 0; i < cands.length;) {
    let j = i;
    while (j < cands.length && cands[j].dist === cands[i].dist) j++;
    const level = cands.slice(i, j).filter((c) => !taken.has(c.d.id) && !usedF.has(c.f.id));
    for (const c of level) {
      if (taken.has(c.d.id) || usedF.has(c.f.id)) continue;
      const group = level.filter((o) => o.d === c.d || o.f === c.f);
      if (group.length === 1) {
        pair(c.f, c.d);
        usedF.add(c.f.id);
        continue;
      }
      for (const o of group) {
        taken.add(o.d.id);
        usedF.add(o.f.id);
      }
      ties.push(
        `note_${c.d.notes[0].id} ↔ ${[...new Set(group.map((o) => o.f.id))].join('|')} (${c.dist} lines)`,
      );
    }
    i = j;
  }
  const paired = new Set([...pairs.values()].map((d) => d.id));
  const unmatched = ours.filter(
    (d) =>
      !paired.has(d.id) && !foreign(d) && (d.notes[0].resolvable || idsIn(d.notes[0].body).length),
  );
  return { pairs, ours, ties, linkMissing, unmatched };
}

// ---------- the author's reply ----------
// Calibrated on a live sample of Russian- and English-speaking teams: "Done: …", "Done your way in
// <sha>", "Agreed, split out in <sha>" vs "Kept: a platform pattern", "A deliberate project
// decision", "Will fix in the next MR", "Done, but not as a wrapper". The regexes below are data matched
// against what authors type, so both languages stay. Classified on the WHOLE body
// (5 of 151 live verdicts changed past the first 140 chars) with the reviewer's `>` quotes removed.
const W = '(?<![\\p{L}\\p{N}_])'; // a word start that holds for Cyrillic — JS `\b` is ASCII-only
const rx = (src) => new RegExp(src, 'iu');
const DECLINE = rx(
  `${W}(?:оставлен|оставля|оставил|оставим|намеренн|осознанн|не будем|не буду|не стал|не стану|не согласен|не согласна|не баг|не нужн|не ломает|не требует|не требуется|не делаю|не делаем|не завож|не заводим|входило в замысел|так (?:и )?задумано|окончательное решение|вне скоуп|не в скоуп|ожидаем\\p{L}* поведени|поведение ожидаем|by design|won'?t fix|out of scope|not a bug|as intended|as expected|expected behaviou?r|no[\\s,.—-]+(?:it'?s |this is )?(?:expected|intended))`,
);
const DEFER = rx(
  `${W}(?:в следующ\\p{L}* (?:MR|мр|PR|ПР|задач|итерац|релиз|верси|спринт)|отдельн\\p{L}* (?:задач|MR|мр|PR|тикет|issue)|вынесен\\p{L}* в (?:отдельн|задач|тикет|бэклог)|позже|на будущее|в бэклог|backlog|follow-?up|later|исправлю|поправлю|сделаю|учту|переделаю|доделаю|уберу|добавлю|вынесу|заведу|will (?:fix|do|address))`,
);
const HEDGE = rx(
  `${W}(?:частично|кроме|за исключением|однако|но не|partially|except)|, но |, but `,
);
const ACCEPT = rx(
  `^[\\s«"'*_\`-]*(?:(?:да|ок|ok|верно|точно|спасибо|согласен|согласна)[\\s,.!:—-]+)*` +
    `(?:сделано|сделал[аи]?|исправлено|исправил[аи]?|поправлено|поправил[аи]?|готово|учтено|учёл|учел|учла|принято|принял[аи]?|перенесено|перенёс|перенес|перенесла|убрано|убрал[аи]?|добавлено|добавил[аи]?|заменено|заменил[аи]?|переделано|переделал[аи]?|вынесено|вынес|вынесла|отделил[аи]?|done|fixed|addressed|applied)(?![\\p{L}])`,
);
const verdictOf = (reply) =>
  DECLINE.test(reply)
    ? 'declined'
    : DEFER.test(reply)
      ? 'deferred'
      : HEDGE.test(reply)
        ? 'unclear'
        : ACCEPT.test(reply)
          ? 'accepted'
          : 'unclear';
const stripQuotes = (s) =>
  String(s)
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim();
// One line, quotes safe inside "…", never cut inside a code span.
function excerpt(s, n = 140) {
  let t = String(s).replace(/\s+/g, ' ').trim().replace(/[«»"]/g, "'");
  if (t.length <= n) return t;
  t = t.slice(0, n);
  if ((t.match(/`/g) || []).length % 2) t = t.slice(0, t.lastIndexOf('`'));
  return t.trimEnd() + '…';
}
const SHA = /(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi;
const shasIn = (s) => [
  ...new Set(
    (String(s).match(SHA) || [])
      .filter((x) => /\d/.test(x) && /[a-f]/i.test(x))
      .map((x) => x.toLowerCase()),
  ),
];

function outcome(d, me, author) {
  const first = d.notes[0];
  const later = d.notes.slice(1).filter((n) => !n.system);
  // Only the MR author speaks for the change: a third reviewer's "agreed, it is a bug" is not acceptance.
  const replies = author === me ? [] : later.filter((n) => n.author?.username === author);
  const otherReplies = later.filter(
    (n) => n.author?.username !== author && n.author?.username !== me,
  ).length;
  const resolvable = d.notes.filter((n) => n.resolvable);
  const resolved = resolvable.length > 0 && resolvable.every((n) => n.resolved);
  const by = resolvable.find((n) => n.resolved_by)?.resolved_by?.username;
  const body = replies.length ? stripQuotes(replies.at(-1).body) : null;
  return {
    first,
    replies,
    otherReplies,
    resolved,
    by,
    body,
    verdict: body == null ? null : verdictOf(body),
  };
}

// ---------- Found by others ----------
const OTHERS = /^##\s+Found by others\s*$/;
const GENERAL_H = '### General comments — no position in the diff, not misses';

function othersSection(lines, iid, now) {
  // Existing rows (and the indented lines a human added under them) survive, keyed by `#note_N`.
  const out = [...lines];
  const sAt = out.findIndex((l) => OTHERS.test(l));
  const old = [];
  if (sAt >= 0) {
    let sEnd = out.findIndex((l, i) => i > sAt && /^#{1,2}\s/.test(l));
    if (sEnd < 0) sEnd = out.length;
    let general = false;
    for (const l of out.slice(sAt + 1, sEnd)) {
      if (/^###\s/.test(l)) general = true;
      else if (/^[-*]\s/.test(l))
        old.push({ key: l.match(/#note_(\d+)/)?.[1] ?? l, lines: [l], general });
      else if (/^\s+\S/.test(l) && old.length) old.at(-1).lines.push(l);
    }
    out.splice(sAt, sEnd - sAt);
  }
  const cur = new Map(now.map((r) => [r.key, r]));
  const rows = [];
  for (const o of old) {
    if (cur.has(o.key)) {
      rows.push({ ...o, general: cur.get(o.key).general });
      cur.delete(o.key);
    } else
      rows.push(
        /left the sample/.test(o.lines[0])
          ? o
          : { ...o, lines: [`${o.lines[0]} · (left the sample ${today})`, ...o.lines.slice(1)] },
      );
  }
  for (const r of cur.values()) rows.push({ key: r.key, lines: [r.text], general: r.general });
  if (!rows.length) return out;
  const pos = rows.filter((r) => !r.general).flatMap((r) => r.lines);
  const gen = rows.filter((r) => r.general).flatMap((r) => r.lines);
  const section = [
    '## Found by others',
    '',
    `Threads of other reviewers on MR !${iid}, opened after our first note and never answered by us (review-sync ${today}). ` +
      'Candidate misses, not a verdict: each gets a class from axis-1 (siblings · parity · hang · before gate · environment · contract) or "not a miss: <why>" on the line below; a new class goes into the profile log.',
    '',
    ...pos,
    ...(pos.length ? [''] : []),
    ...(gen.length ? [GENERAL_H, '', ...gen, ''] : []),
  ];
  if (sAt >= 0) out.splice(sAt, 0, ...section);
  else {
    while (out.length && out.at(-1) === '') out.pop();
    out.push('', ...section);
  }
  return out;
}

// ---------- implicit verdict: commits after the reviewed head ----------
// An audit of ~50 reports: "confirmed by author" read "awaiting replies" in half, because authors
// rarely reply in threads — the precision of what was published went unmeasured. A commit on the MR
// after the reviewed head that changed lines within ±NEAR of a finding's `Where` site is an answer
// without words. Local git only (no network): the branch tip is `--ref`, else the MR's own head sha when
// the MR was fetched and that commit is local, else the one non-default local/remote-tracking ref
// holding the reviewed head. Walked along the first-parent line, oldest first; a merge (main brought
// in) moves the site but is never attributed. Renames are followed and the site is mapped through
// every hunk. The verdict is a `Synced` line only: `Status` never changes — `fixed` is the reviewer's
// after re-running the evidence, and an `addressed` status would leave the parser's `open`/`confirmed`
// sets (hooks/lib/review-report.mjs) and block a later accept flip, which reads `open` only.
const NEAR = 3;
const COMMIT_SYNC = /^\s*[-*]\s+\*\*Synced:\*\*\s*\S+\s+—\s+addressed by\s+([0-9a-f]{7,40})/i;
const SYNC_LINE = /^\s*[-*]\s+\*\*Synced:\*\*/;
const DEFAULT_REF = /^refs\/(?:heads|remotes\/[^/]+)\/(?:main|master|dev|develop|HEAD)$/;
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
};

/** The head the review read, from the header block (before the first `##`): `reviewed head`, the
 *  middle sha of `Base · review · current head`, else a bare `head <sha>` that is not the CURRENT head. */
function reviewedHead(text, single) {
  if (single && opt('--head')) return opt('--head');
  const cut = text.search(/^##\s/m);
  const head = cut < 0 ? text : text.slice(0, cut);
  const SHA_AT = '`?([0-9a-f]{7,40})(?![0-9a-z])';
  return (
    head.match(new RegExp(`reviewed\\s+head\\s*:?\\**\\s*${SHA_AT}`, 'iu'))?.[1] ??
    head.match(
      new RegExp(
        `Base\\s*·\\s*review\\s*·[^:\\n]*:\\**\\s*\`?[0-9a-f]{7,40}\`?\\s*·\\s*${SHA_AT}`,
        'iu',
      ),
    )?.[1] ??
    head.match(new RegExp(`(?<!current\\s)(?<![\\p{L}])head\\s*:?\\**\\s*${SHA_AT}`, 'iu'))?.[1] ??
    null
  );
}

const repoOf = (file, single) =>
  (single && opt('--repo')) ||
  git(path.dirname(path.resolve(file)), ['rev-parse', '--show-toplevel'])?.trim() ||
  null;

/** The tip whose first-parent line runs back to `full`. Divergent candidates pair nothing. */
function resolveTip(repo, full, mrSha, single, iid) {
  const sha = (r) => git(repo, ['rev-parse', '--verify', '-q', `${r}^{commit}`])?.trim() || null;
  const after = (tip) => git(repo, ['merge-base', '--is-ancestor', full, tip]) != null;
  if (single && opt('--ref')) {
    const t = sha(opt('--ref'));
    return t && after(t)
      ? { tip: t, ref: opt('--ref') }
      : { why: `--ref ${opt('--ref')} does not hold the reviewed head` };
  }
  if (mrSha) {
    const t = sha(mrSha);
    if (t && after(t)) return { tip: t, ref: `MR head ${t.slice(0, 7)}` };
  }
  const refs = (
    git(repo, [
      'for-each-ref',
      '--contains',
      full,
      '--format=%(objectname) %(refname)',
      'refs/heads',
      'refs/remotes',
    ]) ?? ''
  )
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([o, r]) => o && r && !DEFAULT_REF.test(r));
  const tips = new Map(); // sha → shortest ref name
  for (const [o, r] of refs) {
    const short = r.replace(/^refs\/(?:heads|remotes)\//, '');
    if (!tips.has(o) || short.length < tips.get(o).length) tips.set(o, short);
  }
  if (!tips.size)
    return {
      why: `no non-default ref holds the reviewed head ${full.slice(0, 7)} (branch gone or rebased)`,
    };
  // A merged MR names its source branch in GitLab's merge commit ("Merge branch 'x' into 'main'" …
  // "See merge request grp/proj!N"): a follow-up branch stacked on the head must not lend its commits.
  if (iid && tips.size > 1) {
    const defaults = (
      git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']) ?? ''
    )
      .split('\n')
      .filter((r) => DEFAULT_REF.test(r));
    const msg = defaults.length
      ? git(repo, [
          'log',
          ...defaults,
          '--merges',
          '-E',
          `--grep=See merge request \\S+!${iid}([^0-9]|$)`,
          '--format=%s',
          '-1',
        ])
      : null;
    const src = msg?.match(/^Merge branch '([^']+)'/)?.[1];
    const named = src && [...tips].find(([, short]) => short === src || short.endsWith(`/${src}`));
    if (named) return { tip: named[0], ref: named[1] };
  }
  const list = [...tips.keys()];
  // All on one line → the furthest; a fork (two branches grew from the head) is ambiguous.
  const top = list.find((t) =>
    list.every((o) => o === t || git(repo, ['merge-base', '--is-ancestor', o, t]) != null),
  );
  if (!top)
    return {
      why: `ambiguous refs hold the reviewed head: ${list.map((t) => tips.get(t)).join(', ')} — pass --ref`,
    };
  return {
    tip: top,
    ref:
      list.length > 1
        ? `${tips.get(top)} (furthest of ${list.length} refs on one line)`
        : tips.get(top),
  };
}

/** First-parent commits head..tip, oldest first, each with its name-status against its first parent. */
function walk(repo, full, tip) {
  const out = git(repo, [
    'log',
    '--reverse',
    '--first-parent',
    '--diff-merges=first-parent',
    '-M',
    '--name-status',
    '--format=@@@%H %cs %P',
    `${full}..${tip}`,
  ]);
  if (out == null) return null;
  const commits = [];
  for (const line of out.split('\n')) {
    const h = line.match(/^@@@([0-9a-f]{40}) (\S+) (.*)$/);
    if (h) {
      const parents = h[3].trim().split(/\s+/).filter(Boolean);
      commits.push({
        sha: h[1],
        date: h[2],
        parent: parents[0],
        merge: parents.length > 1,
        files: [],
      });
      continue;
    }
    const f = line.split('\t');
    if (commits.length && f.length >= 2 && /^[A-Z]/.test(f[0]))
      commits.at(-1).files.push({ st: f[0][0], old: f[1], new: f[2] ?? f[1] });
  }
  if (commits.length && commits[0].parent !== full) return { commits: null };
  return { commits };
}

/** Hunks of one file's diff (-U0): {os, oc, ns, nc}, old-side sorted. */
function hunks(repo, c, oldPath, newPath) {
  const out =
    git(repo, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-M',
      '--unified=0',
      c.parent,
      c.sha,
      '--',
      ...new Set([oldPath, newPath]),
    ]) ?? '';
  return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    os: +m[1],
    oc: m[2] == null ? 1 : +m[2],
    ns: +m[3],
    nc: m[4] == null ? 1 : +m[4],
  }));
}

/** An old-side line through the hunks to the new side; `end` picks the far edge of a replaced block. */
function mapLine(x, hs, end) {
  let delta = 0;
  for (const h of hs) {
    if (h.oc === 0) {
      if (h.os < x)
        delta += h.nc; // inserted after line os, i.e. above x
      else break;
      continue;
    }
    if (h.os + h.oc - 1 < x) {
      delta += h.nc - h.oc;
      continue;
    }
    if (h.os > x) break;
    if (h.nc === 0) return end ? h.ns : h.ns + 1; // x was deleted: collapse to the boundary
    return end ? h.ns + h.nc - 1 : h.ns;
  }
  return x + delta;
}
const touches = (h, a, b) =>
  h.oc === 0 ? h.os >= a - 1 && h.os <= b : h.os <= b && h.os + h.oc - 1 >= a;

/**
 * Per finding: the first non-merge commit after the reviewed head that changed lines within ±NEAR of
 * one of its sites. Returns { source, why, checked, byId: Map(id → {sha, date, file, from, to, deleted}) }.
 */
function implicitVerdicts(
  file,
  text,
  findings,
  { mrSha = null, iid = null, single = false, memo = new Map() } = {},
) {
  const res = { source: null, why: null, checked: 0, byId: new Map(), notes: [] };
  const head = reviewedHead(text, single);
  if (!head) return { ...res, why: 'no reviewed head sha in the header' };
  const repo = repoOf(file, single);
  if (!repo) return { ...res, why: 'the report is not inside a git repo (--repo)' };
  const full = git(repo, ['rev-parse', '--verify', '-q', `${head}^{commit}`])?.trim();
  if (!full) return { ...res, why: `reviewed head ${head} is not in the local repo` };
  const tipKey = `${repo}\0${full}\0${mrSha ?? ''}\0${iid ?? ''}\0${single ? (opt('--ref') ?? '') : ''}`;
  if (!memo.has(tipKey)) {
    const t = resolveTip(repo, full, mrSha, single, iid);
    memo.set(tipKey, t.tip ? { ...t, ...walk(repo, full, t.tip) } : t);
  }
  const t = memo.get(tipKey);
  if (!t.tip) return { ...res, why: t.why };
  if (!t.commits)
    return {
      ...res,
      why: `reviewed head ${full.slice(0, 7)} is not on the first-parent line of ${t.ref}`,
    };
  res.source = `${t.ref}: ${t.commits.filter((c) => !c.merge).length} commits after ${full.slice(0, 7)}`;
  const treeKey = `${repo}\0tree\0${full}`;
  if (!memo.has(treeKey))
    memo.set(
      treeKey,
      (git(repo, ['ls-tree', '-r', '--name-only', full]) ?? '').split('\n').filter(Boolean),
    );
  const tree = memo.get(treeKey);
  const hunkMemo = memo; // shared across findings and lane reports of one run
  for (const f of findings) {
    if (!f.locs.length) continue;
    res.checked++;
    let best = null;
    for (const loc of f.locs) {
      // A full path that exists wins; the 3-component tail match is for elided citations
      // (`svc-a/internal/store/chats.go` also tail-matches svc-b's file).
      const exact = expand(loc.file).filter((c) => tree.includes(c));
      const real = exact.length ? exact : tree.filter((p) => sameFile(p, loc.file));
      if (real.length !== 1) {
        res.notes.push(
          `${f.id}: \`${loc.file}\` ${real.length ? `matches ${real.length} files` : 'is not in the reviewed tree'} — site skipped`,
        );
        continue;
      }
      let p = real[0];
      let a = loc.from;
      let b = loc.to;
      for (let i = 0; i < t.commits.length; i++) {
        if (best && i >= best.i) break; // a later commit cannot beat the one already found
        const c = t.commits[i];
        const fe = c.files.find((x) => x.old === p && x.st !== 'C'); // a copy leaves the original in place
        if (!fe) continue;
        if (fe.st === 'D') {
          if (!c.merge) best = { i, commit: c, file: p, from: a, to: b, deleted: true };
          break;
        }
        const k = `${repo}\0h\0${c.sha}\0${fe.old}\0${fe.new}`;
        if (!hunkMemo.has(k)) hunkMemo.set(k, hunks(repo, c, fe.old, fe.new));
        const hs = hunkMemo.get(k);
        if (!c.merge && hs.some((h) => touches(h, a - NEAR, b + NEAR))) {
          best = { i, commit: c, file: p, from: a, to: b, deleted: false };
          break;
        }
        const na = mapLine(a, hs, false);
        const nb = mapLine(b, hs, true);
        a = na;
        b = Math.max(na, nb);
        p = fe.new;
      }
    }
    if (best)
      res.byId.set(f.id, {
        sha: best.commit.sha,
        date: best.commit.date,
        file: best.file,
        from: best.from,
        to: best.to,
        deleted: best.deleted,
      });
  }
  return res;
}

/** The edits that record the implicit verdict; an existing line naming the same sha is left alone. */
function commitEdits(f, lines, hit, threadSyncAt, anchor) {
  if (!hit) return [];
  const text = `- **Synced:** ${today} — addressed by ${hit.sha.slice(0, 7)} (lines changed)`;
  const at = lines.slice(f.start, f.end).findIndex((l) => COMMIT_SYNC.test(l));
  if (at >= 0)
    return hit.sha.startsWith(lines[f.start + at].match(COMMIT_SYNC)[1].toLowerCase())
      ? []
      : [{ replace: f.start + at, text }];
  return [{ at: threadSyncAt >= 0 ? threadSyncAt : anchor, text }];
}

// ---------- calibration ----------
// accepted = an accepting reply, or `accepted`/`fixed` in the file; declined = a refusing reply (wins
// over a commit near the site: the author said no); addressed = no such reply, a commit changed the
// site; other = deferred/unclear reply, no commit; silent = no reply, no commit; unknown = offline and
// the thread was never synced, so whether the author replied is not known here.
const CLASSES = ['accepted', 'addressed', 'declined', 'other', 'silent', 'unknown'];
const RANK = { accepted: 0, declined: 1, addressed: 2, other: 3, silent: 4, unknown: 5 };
function classify(status, verdict, addressed) {
  if (status === 'accepted' || status === 'fixed' || verdict === 'accepted') return 'accepted';
  if (verdict === 'declined') return 'declined';
  if (addressed) return 'addressed';
  if (verdict === 'deferred' || verdict === 'unclear') return 'other';
  return verdict === 'unknown' ? 'unknown' : 'silent';
}
const VERDICTS = new Set(['accepted', 'declined', 'deferred', 'unclear']);
/** The reply verdict as an earlier networked sync wrote it into the thread `Synced` line. */
function recordedVerdict(line) {
  if (!line) return 'unknown';
  const v = line.match(/last \(([^)]+)\)/)?.[1];
  if (v) return VERDICTS.has(v) ? v : 'unclear';
  return /author did not reply/.test(line) ? null : 'unknown';
}
function calibration(classes) {
  const c = Object.fromEntries(CLASSES.map((k) => [k, 0]));
  for (const k of classes) c[k]++;
  const published = classes.length;
  return { published, ...c };
}
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const calibLine = (c) =>
  `published ${c.published} · accepted ${c.accepted} · addressed ${c.addressed} · declined ${c.declined} · other ${c.other} · silent ${c.silent} (${pct(c.silent, c.published)})` +
  (c.unknown ? ` · reply unknown ${c.unknown}` : '') +
  ` · precision ${pct(c.accepted + c.addressed, c.published)} = (accepted+addressed)/published`;

// Bottom-up so earlier indexes stay valid; at one index a replacement goes before inserts, and of two
// inserts the earlier-queued one ends up on top (Where → Thread → Synced → Synced addressed).
function applyEdits(lines, edits) {
  const out = [...lines];
  const ordered = edits
    .map((e, i) => ({ ...e, i, pos: e.replace ?? e.at }))
    .sort((a, b) => b.pos - a.pos || (b.replace != null) - (a.replace != null) || b.i - a.i);
  for (const e of ordered) {
    if (e.replace != null) out[e.replace] = e.text;
    else out.splice(e.at + 1, 0, e.text);
  }
  return out;
}

// ---------- one report ----------
async function syncOne(
  cred,
  file,
  text,
  me,
  { writeOthers, cache, single = false, memo = new Map() },
) {
  const parsed = parseReport(text);
  const findings = parsed.findings;
  if (!findings.length) return { file, skipped: 'no `## F-NN` finding — not a review report' };
  const iid = mrIid(text, file);
  if (!iid) return { file, skipped: 'no MR iid (H1 `MR !N`, file `mr-N`, or --mr)' };
  const project = projectOf(file);
  if (!project) return { file, skipped: 'no project (--project, or an `origin` remote)' };
  const base = `${cred.api}/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  // One fetch per MR, however many lane reports cover it.
  if (!cache.has(base))
    cache.set(
      base,
      (async () => ({
        mr: (await get(cred, base)).body,
        discussions: (await getAll(cred, `${base}/discussions`)).filter((d) => d.notes?.length),
      }))(),
    );
  const entry = await cache.get(base);
  const { mr, discussions } = entry;
  const author = mr.author?.username;
  const ownMr = author === me;
  const { pairs, ties, linkMissing, unmatched } = match(findings, discussions, me);

  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = []; // { at: insert after line index } | { replace: line index }
  const rows = [];
  const outcomes = [];
  const iv = implicitVerdicts(
    file,
    text,
    findings.filter((f) => pairs.has(f.id)),
    { mrSha: mr.sha, iid, single, memo },
  );
  const classes = [];
  const tally = {
    resolved: 0,
    replied: 0,
    flipped: 0,
    accepted: 0,
    declined: 0,
    deferred: 0,
    unclear: 0,
  };
  for (const f of findings) {
    const d = pairs.get(f.id);
    if (!d) continue;
    const o = outcome(d, me, author);
    if (o.resolved) tally.resolved++;
    if (o.replies.length) tally.replied++;
    if (o.verdict) tally[o.verdict]++;
    let shaNote = '';
    const shas = o.body ? shasIn(o.body) : [];
    if (shas.length) {
      entry.commits ??= getAll(cred, `${base}/commits`);
      const ids = (await entry.commits).map((c) => String(c.id).toLowerCase());
      shaNote =
        '; ' +
        shas
          .map(
            (s) =>
              `commit ${s.slice(0, 10)} ${ids.some((id) => id.startsWith(s)) ? 'in the MR' : 'not found in the MR'}`,
          )
          .join(', ');
    }
    const state = o.resolved
      ? `thread resolved${o.by ? ' @' + o.by : ''}`
      : mr.state === 'merged'
        ? 'MR merged, thread not resolved'
        : 'thread open';
    const said = o.replies.length
      ? `; author replies ${o.replies.length}, last (${o.verdict}): "${excerpt(o.body)}"${shaNote}`
      : '; author did not reply';
    const others = o.otherReplies ? `; other replies ${o.otherReplies}` : '';
    // accepted = the author says it is done. Not `fixed`: that is the reviewer's, after the evidence re-ran.
    const flip =
      o.verdict === 'accepted' &&
      f.status === 'open' &&
      f.severity !== '❓' &&
      mr.state !== 'closed';
    if (flip) tally.flipped++;
    const read =
      {
        declined: ' → DECLINED, read it',
        deferred: ' → DEFERRED, read it',
        unclear: ' → READ the reply',
      }[o.verdict] ?? '';
    const regress =
      f.status === 'accepted' && o.verdict && o.verdict !== 'accepted'
        ? ` → marked accepted, last reply now ${o.verdict}`
        : '';
    const hit = iv.byId.get(f.id) ?? null;
    const cls = classify(f.status, o.verdict, hit);
    classes.push(cls);
    const addr = hit
      ? ` → addressed by ${hit.sha.slice(0, 7)} (${hit.file}:${hit.from}-${hit.to}${hit.deleted ? ', file deleted' : ''})`
      : '';
    rows.push(
      `${f.id}: ${state}${o.replies.length ? `, author replied ${o.replies.length} (${o.verdict})` : ''}${flip ? ' → accepted' : ''}${read}${regress}${addr}`,
    );

    const anchor = f.whereEnd >= 0 ? f.whereEnd : f.start;
    if (!f.threadUrl)
      edits.push({ at: anchor, text: `- **Thread:** ${mr.web_url}#note_${o.first.id}` });
    const syncLine = `- **Synced:** ${today} — ${state}${said}${others}`;
    const block = lines.slice(f.start, f.end);
    const syncAt = block.findIndex((l) => SYNC_LINE.test(l) && !COMMIT_SYNC.test(l));
    // An addressed line written by an --offline run and no thread line yet: the thread line goes right above it.
    const commitAt = block.findIndex((l) => COMMIT_SYNC.test(l));
    edits.push(
      syncAt >= 0
        ? { replace: f.start + syncAt, text: syncLine }
        : { at: commitAt >= 0 ? f.start + commitAt - 1 : anchor, text: syncLine },
    );
    // Queued after the thread line: at one anchor the earlier-queued insert ends up on top.
    edits.push(...commitEdits(f, lines, hit, syncAt >= 0 ? f.start + syncAt : -1, anchor));
    // recorded = the report's Synced line already counts every author reply; a merge or a resolve since
    // changes the line but is no news from the author.
    const recorded =
      syncAt >= 0 &&
      new RegExp(`author replies ${o.replies.length}(?!\\d)`).test(lines[f.start + syncAt]);
    outcomes.push({
      key: `${iid}:${d.id}`,
      resolved: o.resolved,
      replied: o.replies.length > 0,
      lastReply: o.replies.at(-1)?.id ?? null,
      recorded,
      verdict: o.verdict,
      flipped: flip,
      addressed: hit?.sha ?? null,
      cls,
    });
    if (flip)
      edits.push({
        replace: f.statusAt,
        text: lines[f.statusAt].replace(/(Status\s*:\s*\*{0,2}\s*`?)open\b/i, '$1accepted'),
      });
  }

  // Other reviewers' threads: after our review started, never answered by us, not the author's own
  // notes, not bots. A general note (no diff position) is listed apart and is not a miss.
  const mine = discussions
    .flatMap((d) => d.notes)
    .filter((n) => !n.system && n.author?.username === me);
  const since = Math.min(...mine.map((n) => Date.parse(n.created_at)).filter(Number.isFinite));
  const taken = new Set([...pairs.values()].map((d) => d.id));
  const others = ownMr
    ? []
    : discussions.filter((d) => {
        const n = d.notes[0];
        const who = n.author?.username ?? '';
        if (
          taken.has(d.id) ||
          n.system ||
          !n.resolvable ||
          who === me ||
          who === author ||
          BOT.test(who) ||
          n.author?.bot
        )
          return false;
        if (d.notes.some((x) => x.author?.username === me)) return false;
        return !(Number.isFinite(since) && Date.parse(n.created_at) < since);
      });
  const positioned = (d) => Boolean(d.notes[0].position?.new_path || d.notes[0].position?.old_path);
  const otherRows = others.map((d) => {
    const n = d.notes[0];
    const p = n.position;
    const where = positioned(d)
      ? `\`${p.new_path || p.old_path}:${p.new_line ?? p.old_line ?? 'file'}\``
      : 'general';
    const done = d.notes.filter((x) => x.resolvable).every((x) => x.resolved) ? 'closed' : 'open';
    return {
      key: String(n.id),
      general: !positioned(d),
      text: `- @${n.author.username} · ${where} · ${done} · "${excerpt(n.body)}" — ${mr.web_url}#note_${n.id}`,
    };
  });

  let changed = false;
  if (WRITE) {
    let out = applyEdits(lines, edits);
    if (writeOthers) out = othersSection(out, iid, otherRows);
    const next = out.join(eol);
    if (next !== text) {
      writeFileSync(file, next);
      changed = true;
    }
  }
  return {
    file,
    iid,
    state: mr.state,
    ownMr,
    findings: findings.length,
    published: pairs.size,
    ...tally,
    outcomes,
    ours: [...pairs.values()].map((d) => d.id),
    unmatched,
    ties,
    linkMissing,
    others: otherRows.filter((r) => !r.general),
    general: otherRows.filter((r) => r.general),
    writeOthers,
    rows,
    changed,
    calibration: calibration(classes),
    commits: iv.source ?? `n/a — ${iv.why}`,
    ivNotes: iv.notes,
  };
}

// ---------- one report, offline ----------
// No network, no forge call: published = a finding with a `Thread` line; the reply verdict is what an
// earlier networked sync recorded in the thread `Synced` line; the commit verdict comes from local git.
function syncOffline(file, text, { single = false, memo = new Map() } = {}) {
  const findings = parseReport(text).findings;
  if (!findings.length) return { file, skipped: 'no `## F-NN` finding — not a review report' };
  const iid = mrIid(text, file);
  if (!iid) return { file, skipped: 'no MR iid (H1 `MR !N`, file `mr-N`, or --mr)' };
  const published = findings.filter((f) => f.thread);
  const iv = implicitVerdicts(file, text, published, { iid, single, memo });
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];
  const rows = [];
  const outcomes = [];
  const classes = [];
  for (const f of published) {
    const block = lines.slice(f.start, f.end);
    const syncAt = block.findIndex((l) => SYNC_LINE.test(l) && !COMMIT_SYNC.test(l));
    const verdict = recordedVerdict(syncAt >= 0 ? block[syncAt] : null);
    const hit = iv.byId.get(f.id) ?? null;
    const cls = classify(f.status, verdict, hit);
    classes.push(cls);
    // No thread `Synced` line yet: the commit line goes under `Thread` (else under `Where`).
    const threadAt = block.findIndex((l) => /^\s*(?:[-*]\s+)?\*{0,2}Thread\s*:/i.test(l));
    const anchor = Math.max(f.whereEnd, threadAt >= 0 ? f.start + threadAt : -1, f.start);
    const e = commitEdits(f, lines, hit, syncAt >= 0 ? f.start + syncAt : -1, anchor);
    edits.push(...e);
    const note = f.threadUrl?.match(/#note_(\d+)/)?.[1];
    outcomes.push({
      key: note ? `${iid}:note_${note}` : `${iid}:${path.basename(file)}:${f.id}`,
      verdict: verdict === 'unknown' ? null : verdict,
      addressed: hit?.sha ?? null,
      cls,
    });
    rows.push(
      hit
        ? `${f.id}: addressed by ${hit.sha.slice(0, 7)} ${hit.date} (${hit.file}:${hit.from}-${hit.to}${hit.deleted ? ', file deleted' : ''})${e.length ? '' : ' — already recorded'} → ${cls}`
        : `${f.id}: no commit at the site → ${cls}`,
    );
  }
  let changed = false;
  if (WRITE && edits.length) {
    const next = applyEdits(lines, edits).join(eol);
    if (next !== text) {
      writeFileSync(file, next);
      changed = true;
    }
  }
  return {
    file,
    iid,
    offline: true,
    findings: findings.length,
    published: published.length,
    outcomes,
    rows,
    changed,
    pending: edits.length,
    calibration: calibration(classes),
    commits: iv.source ?? `n/a — ${iv.why}`,
    ivNotes: iv.notes,
  };
}

// ---------- main ----------
async function main() {
  // --offline: no forge login checked, no request made — local git and the report text only.
  const cred = OFFLINE ? null : secrets();
  if (cred?.error) {
    console.error(`review-sync: ${cred.error}`);
    return 2;
  }
  let me = opt('--me');
  if (!me && !OFFLINE) {
    try {
      me = (await get(cred, `${cred.api}/user`)).body?.username;
    } catch (e) {
      console.error(`review-sync: ${e.message}`);
      return 2;
    }
    if (!me) {
      console.error('review-sync: cannot resolve the current user; pass --me <username>');
      return 2;
    }
  }

  let files;
  if (ALL) {
    const dir = positional[0] || path.join(process.cwd(), '.agent', 'reviews');
    if (!existsSync(dir)) {
      console.error(`review-sync: no reviews dir: ${dir}`);
      return 2;
    }
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.agent.md'))
      .sort()
      .map((f) => path.join(dir, f));
  } else {
    if (!positional[0]) {
      console.error(
        'usage: review-sync.mjs <report.agent.md> [--mr N] [--project grp/proj] [--me user] [--write] | --all [dir] [--write]',
      );
      return 2;
    }
    files = [positional[0]];
  }
  // "Found by others" goes into ONE report per MR: the first file that is not a `-lane-` split, else the first.
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const primary = new Map();
  for (const f of files) {
    const iid = mrIid(texts.get(f), f);
    const lane = /-lane-/i.test(path.basename(f));
    if (!parseReport(texts.get(f)).findings.length) continue; // a ledger naming the MR is not its report
    if (iid && (!primary.has(iid) || (primary.get(iid).lane && !lane)))
      primary.set(iid, { f, lane });
  }

  const score = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-score.mjs');
  const cache = new Map();
  const memo = new Map(); // git answers shared by every report of the run
  const single = !ALL;
  const results = [];
  let code = 0;
  for (const f of files) {
    const iid = mrIid(texts.get(f), f);
    const p = primary.get(iid);
    const writeOthers = ALL ? p?.f === f : !/-lane-/i.test(path.basename(f));
    let r;
    try {
      r = OFFLINE
        ? syncOffline(f, texts.get(f), { single, memo })
        : await syncOne(cred, f, texts.get(f), me, { writeOthers, cache, single, memo });
    } catch (e) {
      r = {
        file: f,
        skipped: e instanceof HttpError ? e.message : `error: ${scrub(e.message)}`,
        hard: true,
      };
      code = 1;
    }
    results.push(r);
    const name = path.basename(f);
    if (r.skipped) {
      say(`${name}: skipped — ${r.skipped}`);
      continue;
    }
    // The header right after the write: a later report dying must not leave this one half-synced.
    if (r.changed) {
      const s = spawnSync(process.execPath, [score, f, '--write'], { encoding: 'utf8' });
      if (s.status !== 0)
        say(`  ${name}: header not recomputed — ${(s.stderr || s.stdout).trim().split('\n')[0]}`);
    }
    if (r.offline) {
      say(
        `${name} (MR !${r.iid}, offline): findings ${r.findings} · published ${r.published} · commits: ${r.commits} · addressed ${r.calibration.addressed}` +
          (WRITE
            ? r.changed
              ? ' · written'
              : ' · no change'
            : ` · dry run${r.pending ? `, would write ${r.pending} line(s)` : ''}`),
      );
      say(`  calibration: ${calibLine(r.calibration)}`);
      if (!ALL) for (const row of [...r.rows, ...r.ivNotes]) say(`  ${row}`);
      continue;
    }
    say(
      `${name} (MR !${r.iid}, ${r.state}${r.ownMr ? ', own MR' : ''}): findings ${r.findings} · published ${r.published} · resolved ${r.resolved}` +
        ` · author replied ${r.replied} (accepted ${r.accepted}, declined ${r.declined}, deferred ${r.deferred}, unclear ${r.unclear}) · → accepted ${r.flipped}` +
        ` · others ${r.others.length} (+${r.general.length} general)${r.writeOthers ? '' : ' [section in the MR report]'}` +
        (WRITE ? (r.changed ? ' · written' : ' · no change') : ' · dry run') +
        ` · commits: ${r.commits}`,
    );
    say(`  calibration: ${calibLine(r.calibration)}`);
    if (!ALL) {
      for (const row of r.rows) say(`  ${row}`);
      for (const n of r.ivNotes) say(`  ${n}`);
      for (const t of r.ties) say(`  tie, left unpaired: ${t}`);
      for (const l of r.linkMissing) say(`  Thread link points at no thread of this MR: ${l}`);
      for (const d of r.unmatched) {
        const n = d.notes[0];
        const p = n.position;
        say(
          `  unmatched ours: note_${n.id} ${p ? `${p.new_path || p.old_path}:${p.new_line ?? p.old_line ?? 'file'}` : 'general'} "${excerpt(n.body, 80)}"`,
        );
      }
      for (const row of r.others) say(`  other: ${row.text.slice(2, 200)}`);
      for (const row of r.general) say(`  general: ${row.text.slice(2, 160)}`);
    }
  }

  const done = results.filter((r) => !r.skipped);
  if (ALL) {
    // One finding seen from several lane reports counts once, under its strongest evidence.
    const best = new Map();
    for (const o of done.flatMap((r) => r.outcomes))
      if (!best.has(o.key) || RANK[o.cls] < RANK[best.get(o.key)]) best.set(o.key, o.cls);
    const noCommits = done.filter((r) => /^n\/a/.test(r.commits));
    say(
      `CALIBRATION ${calibLine(calibration([...best.values()]))} · commit data n/a in ${noCommits.length} of ${done.length} reports` +
        (noCommits.length
          ? ` (their addressed count is 0 by absence of data, not by evidence)`
          : ''),
    );
  }
  if (ALL && !OFFLINE) {
    // One thread seen from several lane reports counts once; a flip proposed by any lane counts.
    const uniq = new Map();
    for (const o of done.flatMap((r) => r.outcomes)) {
      const prev = uniq.get(o.key);
      uniq.set(o.key, prev ? { ...prev, flipped: prev.flipped || o.flipped } : o);
    }
    const count = (pred) => [...uniq.values()].filter(pred).length;
    const pub = uniq.size;
    const byMr = new Map();
    for (const r of done) {
      const m = byMr.get(r.iid) ?? {
        ours: new Set(),
        unmatched: new Map(),
        others: new Map(),
        general: new Map(),
        own: r.ownMr,
      };
      r.ours.forEach((id) => m.ours.add(id));
      r.unmatched.forEach((d) => m.unmatched.set(d.id, d));
      r.others.forEach((o) => m.others.set(o.key, o));
      r.general.forEach((o) => m.general.set(o.key, o));
      byMr.set(r.iid, m);
    }
    const sum = (fn) => [...byMr.values()].reduce((n, m) => n + fn(m), 0);
    const unmatched = sum((m) => [...m.unmatched.keys()].filter((id) => !m.ours.has(id)).length);
    const oth = sum((m) => m.others.size);
    const gen = sum((m) => m.general.size);
    const own = [...byMr.values()].filter((m) => m.own).length;
    const top = [...byMr.entries()]
      .filter(([, m]) => m.others.size)
      .sort((a, b) => b[1].others.size - a[1].others.size)
      .slice(0, 5);
    // Status as it now stands in the files, not the pending delta.
    const statuses = {};
    for (const r of done)
      for (const f of parseReport(readFileSync(r.file, 'utf8')).findings)
        statuses[f.status ?? 'none'] = (statuses[f.status ?? 'none'] ?? 0) + 1;
    say(
      `TOTAL reports ${done.length} (skipped ${results.length - done.length}) · MRs ${byMr.size} (own ${own}) · published ${pub} · unmatched ours ${unmatched} · resolved ${count((o) => o.resolved)}` +
        ` · author replies: accepted ${count((o) => o.verdict === 'accepted')}, declined ${count((o) => o.verdict === 'declined')}, deferred ${count((o) => o.verdict === 'deferred')}, unclear ${count((o) => o.verdict === 'unclear')}` +
        ` · → accepted ${count((o) => o.flipped)}${WRITE ? '' : ' (dry run)'} · others' threads ${oth} (+${gen} general, not counted)` +
        (pub + oth
          ? ` · share of others' threads ${Math.round((100 * oth) / (pub + oth))}% — not recall: every positioned other counts, unfound defects do not`
          : ''),
    );
    if (top.length)
      say(`others by MR: ${top.map(([iid, m]) => `!${iid} ${m.others.size}`).join(', ')}`);
    say(
      `statuses in files: ${Object.entries(statuses)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}`,
    );
  }
  if (JSON_OUT) {
    // `hard` = an HTTP/network skip: the caller keeps its last good result for that file. An other's
    // thread is `recorded` once any report of its MR carries its #note_N ("Found by others" goes into one).
    const noted = (iid, key) =>
      files.some(
        (f) =>
          mrIid(texts.get(f), f) === iid && new RegExp(`#note_${key}(?!\\d)`).test(texts.get(f)),
      );
    const slim = (r) =>
      r.skipped
        ? { file: r.file, skipped: r.skipped, hard: Boolean(r.hard) }
        : {
            file: r.file,
            iid: r.iid,
            state: r.state,
            ownMr: r.ownMr,
            flipped: r.flipped,
            outcomes: r.outcomes,
            others: (r.others ?? []).map((o) => ({ key: o.key, recorded: noted(r.iid, o.key) })),
            calibration: r.calibration,
            commits: r.commits,
          };
    console.log(JSON.stringify({ reports: results.map(slim) }));
  }
  return code;
}

process.exitCode = await main();
