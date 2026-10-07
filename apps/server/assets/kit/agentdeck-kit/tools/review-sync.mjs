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
//
//   node <kit>/tools/review-sync.mjs <report.agent.md> [--mr N] [--project grp/proj] [--me user] [--write]
//   node <kit>/tools/review-sync.mjs --all [<reviews-dir>] [--write]     calibration over every MR report
//   … --json   one JSON object on stdout instead of the text (review-sync-brief's background run)
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
const VALUED = new Set(['--mr', '--project', '--me']);
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

// ---------- one report ----------
async function syncOne(cred, file, text, me, { writeOthers, cache }) {
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
    rows.push(
      `${f.id}: ${state}${o.replies.length ? `, author replied ${o.replies.length} (${o.verdict})` : ''}${flip ? ' → accepted' : ''}${read}${regress}`,
    );

    const anchor = f.whereEnd >= 0 ? f.whereEnd : f.start;
    if (!f.threadUrl)
      edits.push({ at: anchor, text: `- **Thread:** ${mr.web_url}#note_${o.first.id}` });
    const syncLine = `- **Synced:** ${today} — ${state}${said}${others}`;
    const syncAt = lines
      .slice(f.start, f.end)
      .findIndex((l) => /^\s*[-*]\s+\*\*Synced:\*\*/.test(l));
    edits.push(
      syncAt >= 0 ? { replace: f.start + syncAt, text: syncLine } : { at: anchor, text: syncLine },
    );
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
    // Bottom-up so earlier indexes stay valid; at one index a replacement goes before inserts, and of two
    // inserts the earlier-queued one ends up on top (Where → Thread → Synced).
    let out = [...lines];
    const ordered = edits
      .map((e, i) => ({ ...e, i, pos: e.replace ?? e.at }))
      .sort((a, b) => b.pos - a.pos || (b.replace != null) - (a.replace != null) || b.i - a.i);
    for (const e of ordered) {
      if (e.replace != null) out[e.replace] = e.text;
      else out.splice(e.at + 1, 0, e.text);
    }
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
  };
}

// ---------- main ----------
async function main() {
  const cred = secrets();
  if (cred.error) {
    console.error(`review-sync: ${cred.error}`);
    return 2;
  }
  let me = opt('--me');
  if (!me) {
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
  const results = [];
  let code = 0;
  for (const f of files) {
    const iid = mrIid(texts.get(f), f);
    const p = primary.get(iid);
    const writeOthers = ALL ? p?.f === f : !/-lane-/i.test(path.basename(f));
    let r;
    try {
      r = await syncOne(cred, f, texts.get(f), me, { writeOthers, cache });
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
    say(
      `${name} (MR !${r.iid}, ${r.state}${r.ownMr ? ', own MR' : ''}): findings ${r.findings} · published ${r.published} · resolved ${r.resolved}` +
        ` · author replied ${r.replied} (accepted ${r.accepted}, declined ${r.declined}, deferred ${r.deferred}, unclear ${r.unclear}) · → accepted ${r.flipped}` +
        ` · others ${r.others.length} (+${r.general.length} general)${r.writeOthers ? '' : ' [section in the MR report]'}` +
        (WRITE ? (r.changed ? ' · written' : ' · no change') : ' · dry run'),
    );
    if (!ALL) {
      for (const row of r.rows) say(`  ${row}`);
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
            others: r.others.map((o) => ({ key: o.key, recorded: noted(r.iid, o.key) })),
          };
    console.log(JSON.stringify({ reports: results.map(slim) }));
  }
  return code;
}

process.exitCode = await main();
