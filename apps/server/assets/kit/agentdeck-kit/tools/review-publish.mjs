#!/usr/bin/env node
// Report → forge-ready review cards in one pass, so publishing is N parallel tool calls instead of a
// hand-edit loop per card (measured: the publish phase cost the orchestrator 9.9M tokens of a 32.9M review —
// split, head rewrite, scrub, re-anchor and guard denials were done card by card).
//
//   node review-publish.mjs prepare --report <x.agent.md> --out <dir> --base-sha <s> --start-sha <s> --head-sha <s> [--repo <dir>]
//   node review-publish.mjs index   --report <x.agent.md> --out <file> [--manifest <dir>/manifest.json]
//
// prepare writes per finding `F-NN.md` (the card body, review-publish-guard shape: severity first, `F-NN`,
// a bold one-line thesis, `**Where:** path:start-end` equal to the anchor) and `F-NN.pos.json` (`position`
// for create_merge_request_thread, plus the GitHub form), and `manifest.json`. A site outside the diff is
// re-anchored to its shown part or the first shown «other sites» entry (the card's `**Where:**` rewritten to
// match); none shown → `outside`, it goes to the summary note. «same as F-NN» folds into F-NN. Scaffolding
// words are stripped where the rewrite is safe and FLAGGED where it needs a sentence rewritten — the
// orchestrator edits only the flagged lines (exit 4 while flags remain; a rerun after the edits is not
// needed — edit the card files in place).
// index writes the summary-note draft: verdict and praise from the report, outside-diff sites, the finding
// list by severity linked to the `**Thread:**` URLs review-sync wrote into the report.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildPosition, parseHunks } from './review-position.mjs';

const LABEL = { '🔴': 'blocking', '🟡': 'before merge', '🟢': 'nit', '❓': 'question' };
const SEV_ORDER = ['🔴', '🟡', '❓', '🟢'];
// Review-only fields: the author reads the card, not the review's bookkeeping.
const DROP_FIELD = /^\s*-\s+\*\*(Status|Axis|Thread|Synced):\*\*/;
const FOLD = /^same as\s+(F-\d+)\s*[:.,—-]?\s*/i;
const OTHER_SITES = /\(other sites:\s*([^)]*)\)/;

/** Safe rewrites: the meaning stays, only the review's own machinery leaves the text. */
export const SCRUB = [
  [/\s*\(L[0-4]\s*[—-]\s*([^)]*)\)/g, ' ($1)'],
  [/\bL[0-4]\s*[—-]\s*/g, ''],
  [/\s*`?--label claude\.ephemeral=1`?/g, ''],
  [/\s*--rm --label claude\.ephemeral=1/g, ' --rm'],
];
/** Left for a human-grade rewrite: the sentence around them must change, not one word. */
export const FLAGS = [
  [/\bL[0-4]\b/, 'rung label'],
  [/zz_lane[\w.-]*|\bprobe\d*\.mjs\b/i, 'probe file name'],
  [/\bclone\b/i, '«clone» — say «the branch» / «the head»'],
  [/scratch/i, 'scratch dir'],
  [/claude\.ephemeral/, 'container label'],
  // `I` case-sensitive and not `I/O`; the rest lowercase as prose writes them
  [/\b(?:I(?![/\w])|I'm|I've|me|my|mine)\b/, 'first person'],
  [/\b(?:lane|prover|brief)s?\b/i, 'review machinery'],
];

const git = (repo, ...a) => {
  const r = spawnSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
};
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) (o._ ??= []).push(a);
    else o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

/** Markdown emphasis outside code spans removed; a `*` inside a code span is code and stays. */
const plain = (s) =>
  String(s)
    .replace(/`[^`]*`|\*+/g, (m) => (m.startsWith('`') ? m : ''))
    .trim();
/**
 * The opening clause of a thesis: up to the first `: ` (or, with `sentence`, `. `) outside backticks;
 * whole text when none.
 */
export function clause(s, { sentence = false } = {}) {
  // only at depth 0: a `: ` inside parentheses or «quotes» is part of a citation, not the clause end
  let tick = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') tick = !tick;
    else if (tick) continue;
    else if (s[i] === '(' || s[i] === '«') depth++;
    else if ((s[i] === ')' || s[i] === '»') && depth > 0) depth--;
    else if (!depth && s[i + 1] === ' ' && (s[i] === ':' || (sentence && s[i] === '.' && i > 20)))
      return [s.slice(0, s[i] === '.' ? i + 1 : i), s.slice(i + 1).trim()];
  }
  return [s, ''];
}
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * `**thesis**` with no `*` inside the bold (the guard's shape): a code span holding `*` (`GIT_CONFIG_*`)
 * ends the bold before it, the rest follows plain.
 */
export function boldHead(text) {
  const t = plain(text);
  const star = t.search(/`[^`]*\*[^`]*`/);
  if (star < 0) return `**${t}**`;
  const before = t.slice(0, star).trim();
  return before.length >= 3 ? `**${before}** ${t.slice(star)}` : `**Finding:** ${t}`;
}

/** Findings of an assembled report: F-blocks (`### F-NN …`) and nit lines (`- F-NN 🟢 … — **Where:** …`). */
export function parseReport(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  let section = '';
  for (const l of lines) {
    if (/^## /.test(l)) {
      section = l.slice(3).trim();
      cur = null;
      continue;
    }
    const h = l.match(/^### (F-\d+) ((?:🔴|🟡|🟢|❓)🔵?)\s+(.*)$/u);
    if (h) {
      cur = {
        id: h[1],
        marks: h[2],
        sev: [...h[2]][0],
        sec: h[2].includes('🔵'),
        thesis: h[3].trim(),
        body: [],
        nit: false,
      };
      out.push(cur);
      continue;
    }
    if (/^### /.test(l)) {
      cur = null;
      continue;
    }
    if (cur) {
      cur.body.push(l);
      continue;
    }
    const n = /Nits/i.test(section) && l.match(/^- (F-\d+) ((?:🔴|🟡|🟢|❓)🔵?)\s+(.*)$/u);
    if (n) {
      const w = n[3].match(/\s+—\s+\*\*Where:\*\*\s+(`[^`]+`(?:\s*\([^)]*\))?)/);
      const thesis = (w ? n[3].slice(0, w.index) : n[3]).trim();
      out.push({
        id: n[1],
        marks: n[2],
        sev: [...n[2]][0],
        sec: n[2].includes('🔵'),
        thesis,
        where: w ? w[1] : null,
        body: [],
        nit: true,
      });
    }
  }
  for (const f of out) {
    const fold = f.thesis.match(FOLD);
    if (fold) Object.assign(f, { foldedInto: fold[1], thesis: f.thesis.slice(fold[0].length) });
    f.thread = f.body.join('\n').match(/\*\*Thread:\*\*\s+(\S+)/)?.[1] ?? null;
  }
  // nit thread lines sit on the line after the nit
  for (let k = 0; k < lines.length; k++) {
    const n = lines[k].match(/^- (F-\d+) (?:🔴|🟡|🟢|❓)/u);
    if (!n) continue;
    const f = out.find((x) => x.id === n[1] && x.nit);
    const next = lines[k + 1]?.match(/^- \*\*Thread:\*\*\s+(\S+)/);
    if (f && next) f.thread = next[1];
  }
  return out;
}

/** `701,711-713` → ranges of one file. */
const ranges = (file, list) =>
  list.split(/,\s*/).map((r) => {
    const [a, b] = r.split(/[-–]/);
    return { file, from: +a, to: +(b ?? a) };
  });
/**
 * Where-line places: the main `path:a-b` (a comma list `path:701,711` gives one place per item — the
 * first is the main one) and every `path:n` / bare `:n` of its parenthetical, in order.
 */
export function placesOf(where) {
  const m = String(where).match(/`([^`\s]+?):(\d+(?:[-–]\d+)?(?:,\s*\d+(?:[-–]\d+)?)*)`/);
  if (!m) return [];
  const [main, ...same] = ranges(m[1], m[2]);
  main.text = `${m[1]}:${m[2]}`;
  const rest = String(where).slice(m.index + m[0].length);
  const others = [];
  for (const x of rest.matchAll(
    /`?((?:[\w.@~-]+\/)*[\w.@~-]+\.\w+)?:(\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*)`?/g,
  )) {
    others.push(...ranges(x[1] ?? main.file, x[2]));
  }
  return [main, ...same, ...others];
}

function scrub(text) {
  let t = text;
  for (const [re, to] of SCRUB) t = t.replace(re, to);
  return t;
}
function flagsOf(id, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    // code spans are code — except the scaffolding names, which stay visible to the flags
    const bare = line.replace(/`[^`]*`/g, (s) =>
      /zz_lane|probe\d*\.mjs|claude\.ephemeral|\bclone\b/i.test(s) ? s : '``',
    );
    for (const [re, what] of FLAGS)
      if (re.test(bare)) out.push(`${id}.md:${i + 1} ${what} — ${line.trim().slice(0, 110)}`);
  });
  return out;
}

/** Card body of one finding (folded ones appended by the caller). */
export function cardOf(f) {
  const head = `${f.marks} ${LABEL[f.sev]} ${f.id}`;
  if (f.nit) {
    const [first, rest] = clause(f.thesis, { sentence: true });
    const lines = [`${head} ${boldHead(upper(first))}`, '', ...(rest ? [upper(rest), ''] : [])];
    if (f.where) lines.push(`- **Where:** ${f.where}`);
    return lines.join('\n');
  }
  const body = [];
  let dropping = false;
  for (const l of f.body) {
    if (DROP_FIELD.test(l)) {
      dropping = true;
      continue;
    }
    if (dropping && /^\s{2,}\S/.test(l)) continue;
    dropping = false;
    body.push(l);
  }
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  return [`${head} ${boldHead(f.thesis)}`, '', ...body].join('\n');
}

function prepare(o) {
  const need = ['report', 'out', 'base-sha', 'head-sha'];
  const miss = need.filter((k) => !o[k] || o[k] === true);
  if (miss.length) {
    console.error(`review-publish prepare: missing --${miss.join(', --')}`);
    return 2;
  }
  const repo = path.resolve(o.repo ?? '.');
  const shas = { base: o['base-sha'], start: o['start-sha'] ?? o['base-sha'], head: o['head-sha'] };
  const findings = parseReport(readFileSync(o.report, 'utf8'));
  if (!findings.length) {
    console.error('review-publish prepare: no `### F-NN` block and no nit line in the report');
    return 2;
  }
  mkdirSync(o.out, { recursive: true });
  const renames = new Map();
  const st = (git(repo, 'diff', '--name-status', '-z', '-M', shas.base, shas.head) ?? '').split(
    '\0',
  );
  for (let k = 0; k < st.length; k++) if (/^R\d*$/.test(st[k])) renames.set(st[k + 2], st[k + 1]);
  const fileCache = new Map();
  const fileInfo = (file) => {
    if (!fileCache.has(file)) {
      const old = renames.get(file) ?? file;
      const diff = git(
        repo,
        'diff',
        '-U0',
        '-M',
        shas.base,
        shas.head,
        '--',
        file,
        ...(old === file ? [] : [old]),
      );
      const body = git(repo, 'show', `${shas.head}:${file}`);
      fileCache.set(file, {
        old,
        hunks: diff ? parseHunks(diff) : [],
        length: body === null ? null : body.split('\n').length - (body.endsWith('\n') ? 1 : 0),
      });
    }
    return fileCache.get(file);
  };
  // a short path (`a.mjs`) resolves to the one diff path ending with it
  const resolve = (file) => {
    if (fileInfo(file).hunks.length) return file;
    const hit = (git(repo, 'diff', '--name-only', shas.base, shas.head) ?? '')
      .split('\n')
      .filter((p) => p && p.endsWith('/' + file));
    return hit.length === 1 ? hit[0] : file;
  };
  const tryPos = (file, from, to) => {
    const f = resolve(file);
    const info = fileInfo(f);
    if (!info.hunks.length) return null;
    const at = (start, end) => ({
      file: f,
      from: start,
      to: end,
      ...buildPosition({
        file: f,
        oldPath: info.old,
        start,
        end,
        hunks: info.hunks,
        shas,
        length: info.length,
      }),
    });
    try {
      return at(from, to);
    } catch (e) {
      if (e.code !== 3) return null;
      // the shown part of the range, when one exists
      let a = null;
      for (let n = from; n <= to; n++) {
        let ok = true;
        try {
          at(n, n);
        } catch {
          ok = false;
        }
        if (ok && a === null) a = n;
        if (!ok && a !== null) return at(a, n - 1);
      }
      return a === null ? null : at(a, to);
    }
  };

  const manifest = [];
  const flags = [];
  const bodies = new Map();
  for (const f of findings) if (!f.foldedInto) bodies.set(f.id, cardOf(f));
  for (const f of findings.filter((x) => x.foldedInto)) {
    const target = bodies.get(f.foldedInto);
    if (!target) {
      bodies.set(f.id, cardOf({ ...f, foldedInto: undefined }));
      delete f.foldedInto;
      continue;
    }
    const where = f.nit ? f.where : (f.body.join('\n').match(/\*\*Where:\*\*\s+(.+)/)?.[1] ?? '');
    bodies.set(
      f.foldedInto,
      `${target}\n\n**Same defect in another form:** ${f.thesis}${where ? ` — ${where}` : ''}`,
    );
    manifest.push({ id: f.id, sev: f.sev, kind: 'folded', foldedInto: f.foldedInto });
  }
  for (const f of findings.filter((x) => !x.foldedInto)) {
    let text = scrub(bodies.get(f.id));
    const whereLine = text.match(/^(-\s+)?\*\*Where:\*\*\s+(.+)$/m);
    const places = whereLine ? placesOf(whereLine[2]) : [];
    let pos = null;
    let reanchored = false;
    for (const [i, p] of places.entries()) {
      pos = tryPos(p.file, p.from, p.to);
      if (pos) {
        reanchored = i > 0 || pos.from !== p.from || pos.to !== p.to;
        break;
      }
    }
    if (pos && reanchored) {
      const main = places[0];
      const at = `${pos.file}:${pos.from}${pos.to > pos.from ? `-${pos.to}` : ''}`;
      const paren = whereLine[2].match(OTHER_SITES);
      const others = [`\`${main.text}\``, ...(paren ? [paren[1]] : [])].join(', ');
      text = text.replace(
        whereLine[0],
        `${whereLine[1] ?? ''}**Where:** \`${at}\` (other sites: ${others})`,
      );
    }
    writeFileSync(path.join(o.out, `${f.id}.md`), text + '\n');
    const fl = flagsOf(f.id, text);
    flags.push(...fl);
    if (pos)
      writeFileSync(
        path.join(o.out, `${f.id}.pos.json`),
        JSON.stringify({ position: pos.position, github: pos.github }, null, 2) + '\n',
      );
    manifest.push({
      id: f.id,
      sev: f.sev,
      sec: f.sec,
      kind: pos ? 'thread' : 'outside',
      body: `${f.id}.md`,
      ...(pos
        ? { position: `${f.id}.pos.json`, anchor: `${pos.file}:${pos.from}-${pos.to}`, reanchored }
        : { site: places[0]?.text ?? null }),
      thread: f.thread,
      flags: fl.length,
    });
  }
  manifest.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  writeFileSync(
    path.join(o.out, 'manifest.json'),
    JSON.stringify({ report: path.resolve(o.report), shas, cards: manifest }, null, 2) + '\n',
  );
  for (const m of manifest) {
    console.log(
      `${m.id} ${m.sev} ${m.kind}${m.anchor ? ` ${m.anchor}${m.reanchored ? ' (re-anchored)' : ''}` : ''}${m.site ? ` ${m.site} → summary note` : ''}${m.foldedInto ? ` → ${m.foldedInto}` : ''}${m.flags ? ` · ${m.flags} flag(s)` : ''}`,
    );
  }
  const count = (k) => manifest.filter((m) => m.kind === k).length;
  console.log(
    `\n${count('thread')} thread card(s), ${count('outside')} outside the diff, ${count('folded')} folded → ${path.join(o.out, 'manifest.json')}`,
  );
  if (flags.length) {
    console.log(
      `\nFLAGS (${flags.length}) — rewrite these lines in the card files (Edit), then publish:`,
    );
    for (const f of flags) console.log(`  ${f}`);
    return 4;
  }
  console.log(
    'publish: one create_merge_request_thread per thread card — body = the .md file, position = .pos.json `position` (GitHub: its `github` form); all cards in one message.',
  );
  return 0;
}

/** Text of a `## <name>` section of the report, without the heading. */
const sectionOf = (text, name) => {
  const m = text.match(new RegExp(`^## ${name}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
};

function index(o) {
  if (!o.report || !o.out) {
    console.error(
      'review-publish index: --report <x.agent.md> --out <file> [--manifest <manifest.json>]',
    );
    return 2;
  }
  const text = readFileSync(o.report, 'utf8');
  const findings = parseReport(text).filter((f) => !f.foldedInto);
  const man =
    o.manifest && existsSync(o.manifest) ? JSON.parse(readFileSync(o.manifest, 'utf8')).cards : [];
  const outside = man.filter((m) => m.kind === 'outside');
  const re = man.filter((m) => m.reanchored);
  const count = (s) => findings.filter((f) => f.sev === s).length;
  const lines = ['## Review: summary', ''];
  lines.push(
    `**Summary:** ${SEV_ORDER.map((s) => `${s} ${count(s)}`).join(' · ')}${count('🔴') ? '' : ' — no blocking (🔴) findings'}.`,
    '',
  );
  const verdict = sectionOf(text, 'Verdict on the stated');
  if (verdict) lines.push(`**Verdict.** ${verdict}`, '');
  const checked = text.match(/^\*\*Verified:\*\*\s*(.+)$/m)?.[1];
  if (checked) lines.push(`**What was checked.** ${scrub(checked)}`, '');
  if (outside.length || re.length) {
    lines.push('**Outside the diff.**');
    for (const m of outside)
      lines.push(
        `- ${m.id} — \`${m.site}\`: no thread can be pinned to the line, the whole finding is here.`,
      );
    for (const m of re)
      lines.push(
        `- ${m.id} — root outside the shown lines; thread pinned to \`${m.anchor}\`, the original site named in it.`,
      );
    lines.push('');
  }
  const good = sectionOf(text, 'Done well');
  if (good)
    lines.push(
      `**Done well.** ${good
        .split('\n')
        .map((l) => l.replace(/^-\s+/, '').trim())
        .filter(Boolean)
        .join(' ')}`,
      '',
    );
  lines.push('**Findings.**', '');
  for (const s of SEV_ORDER) {
    const list = findings.filter((f) => f.sev === s);
    if (!list.length) continue;
    lines.push(`${s} ${s === '🟢' ? "nits, at the author's discretion" : LABEL[s]}`);
    for (const f of list) {
      const short = plain(clause(f.thesis)[0]).slice(0, 110);
      lines.push(
        `- ${f.id}${f.sec ? ' 🔵' : ''} ${f.thread ? `[${short}](${f.thread})` : `${short} (no thread in the report — run review-sync --write first)`}`,
      );
    }
    lines.push('');
  }
  const body = lines.join('\n').trimEnd() + '\n';
  writeFileSync(o.out, body);
  const fl = flagsOf('index', body);
  console.log(
    `${o.out}: ${findings.length} findings, ${findings.filter((f) => f.thread).length} linked, ${Buffer.byteLength(body)} B`,
  );
  if (fl.length) {
    console.log(`FLAGS (${fl.length}) — rewrite before publishing:`);
    for (const f of fl) console.log(`  ${f}`);
    return 4;
  }
  return 0;
}

if (process.argv[1]?.endsWith('review-publish.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const run = { prepare, index }[cmd];
  if (run) process.exitCode = run(o);
  else {
    console.error('usage: review-publish.mjs prepare|index … (header comment)');
    process.exitCode = 2;
  }
}
