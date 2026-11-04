#!/usr/bin/env node
// deep-review merge + proof fan-out + report assembly. Measured on Claude Code transcripts: after
// the lanes ONE agent merged lane files, proved every candidate and wrote the report — 6.8M tokens, 61 turns,
// peak context 165k, 19 min, more than a lane (4.7M); over a batch of 11 MRs these writers spent 75M against
// 67M for all lanes. Most of it was proving inside a huge context and re-reading lane files. This tool does
// the mechanical part (union, briefs, assembly) so proving runs in small parallel contexts and the report is
// stitched without a model re-reading anything.
//
//   node review-merge.mjs merge --dir <review dir> [--plan <plan.json>] [--max-per-prover 6] [--max-nits 40]
//       lane-*.md → merged.md + merged.json + prove-<k>.prompt.md (non-🟢, by directory) + prove-nits.prompt.md
//       (every 🟢, cite-only); prints one spawn stub per brief (description `deep-review verify prove-<k>`).
//   node review-merge.mjs assemble --dir <review dir> --plan <plan.json> --out <report.agent.md>
//       [--fill <header.md>] [--tier T2] [--title "<what>"] [prover outputs… | default <dir>/prove-*.out.md]
//       skeleton (review-plan.mjs, as a process) + the provers' blocks renumbered F-01… by severity + kills as
//       `- ✗` lines; Summary/Score computed; checked with the report gate's own writeProblems(). A report the
//       gate refuses is written as <out>.draft.md (outside the guarded name) and the exit is 1.
//
// Merge rules (lanes.md §Merge): union keyed by site and mechanism; agreement never raises severity (the
// cluster carries the max of what its members said, nothing more); absence of agreement never drops a
// candidate; only proof kills. Two candidates join when they share a file and a line within ±3 and their
// mechanism tokens overlap (Jaccard ≥ 0.3), or when they cite the same file and the same line.
//
// Candidate shapes read from a lane file:
//   new     `- C<lane><n> · <path>:<line>[-<end>] · <mechanism> · <🔴|🟡|🟢|❓ [🔵]> · <high|mid|low> · <proof>` (anywhere)
//   legacy  `- <id> · <site …> · <mechanism> · <severity word> · <confidence> · <what would prove it>`
//           (inside a «Candidates» section only; severity found as the first field from the
//           third on that opens with a severity word)
//   block   `### <id> <🔴|🟡|🟢|❓> <thesis>` + a `Where:` line, inside a «Findings»/«Candidates» section
// Never candidates: ledger table rows (`| path | read … |`), `clean — file:line` cells, lines with no severity.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport, scoreLines, writeProblems } from '../hooks/lib/review-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN_TOOL = process.env.REVIEW_PLAN_TOOL || path.join(HERE, 'review-plan.mjs');
export const BRIEF_TARGET = 8192;
const SEV_ORDER = ['🔴', '🟡', '❓', '🟢'];
const sevRank = (s) => {
  const i = SEV_ORDER.indexOf(s);
  return i < 0 ? SEV_ORDER.length : i;
};
const CONF_RANK = { high: 0, mid: 1, low: 2, '?': 3 };

// ---- parsing -------------------------------------------------------------------------------------------

const EXT =
  'tsx?|jsx?|mjs|cjs|go|py|mdx?|json|ya?ml|sql|s?css|sh|ps1|conf|toml|txt|html?|proto|rs|java|kt|vue|env|ini|lock|mod|sum|tpl|csv';
// `path:line[-end]`, path either has a slash or a known extension; `Dockerfile`/`Makefile` count too.
const LOC_RE = new RegExp(
  String.raw`((?:[\w.@{}~-]+\/)+[\w.@{}~-]+|[\w@{}~-][\w.@{}~-]*\.(?:${EXT})|Dockerfile|Makefile):(\d+)(?:\s*[-–]\s*(\d+))?`,
  'g',
);
const FILE_RE = new RegExp(
  String.raw`((?:[\w.@{}~-]+\/)+[\w@{}~-][\w.@{}~-]*\.(?:${EXT})|[\w@{}~-][\w.@{}~-]*\.(?:${EXT})|(?:[\w.@{}~-]+\/)+[\w.@{}~-]+)(?![\w/])`,
  'i',
);
// Lookahead, not `\b`: `\b` after an emoji needs a word char next, so a bare `· 🟢 ·` field read as no
// severity (measured: two lane candidates dropped to the by-eye list).
const SEV_WORD =
  /^[*_`]*\s*(🔴|🟡|🟢|❓|blocker|critical|severe|major|minor|medium|med|moderate|nit|nitpick|trivial|info|informational|cosmetic|style|none|question|unknown|low|high)(?![\p{L}\p{N}_])/iu;
const SEV_MAP = {
  blocker: '🔴',
  critical: '🔴',
  severe: '🔴',
  high: '🔴',
  major: '🟡',
  minor: '🟡',
  medium: '🟡',
  med: '🟡',
  moderate: '🟡',
  nit: '🟢',
  nitpick: '🟢',
  trivial: '🟢',
  info: '🟢',
  informational: '🟢',
  cosmetic: '🟢',
  style: '🟢',
  none: '🟢',
  low: '🟢',
  question: '❓',
  unknown: '❓',
};
const CONF_WORD = /\b(high|mid|medium|low)\b/i;
const ID_RE =
  /^[*_`]*([A-Z][A-Za-z]?\d*(?:-[A-Z]?\d+)?|[A-Z]\d+-\d+|C-[A-Z]\d+)[*_`]*(?:\s*\([^)]*\))?$/;
// The site may carry a parenthetical (`x.mdx:63 (and :194 :339)`, `(+6 siblings)`): kept, prefixed to the mechanism.
const NEW_RE =
  /^\s*[-*]\s+[*_`]*(C[A-Z][\w-]*)[*_`]*\s+·\s+`?([^\s·`]+?):(\d+)(?:-(\d+))?`?(?:\s+(\([^)]*\)))?\s+·\s+(.+?)\s+·\s+(🔴|🟡|🟢|❓)\s*(🔵)?\s+·\s+(high|mid|low)\s+·\s+(.+)$/u;
const CAND_SECTION = /candidate/i;
const BLOCK_SECTION = /candidate|finding/i;
const STOP = new Set(
  (
    'the and for with that this not from are but has have when while only line file read into than then also ' +
    "its it's via per one two any all can does did was were will would should could must may each both same " +
    'still just more less which what who whose there here they them their our out off over under after before ' +
    'because since without within ' +
    'proof prove read grep check test head base diff high mid low nit minor major info medium'
  ).split(/\s+/),
);

/** Lowercased word tokens of a mechanism text, numbers, stop words and path pieces left out. */
export function tokens(text) {
  const clean = String(text ?? '')
    .replace(LOC_RE, ' ')
    .replace(/`[^`]*`/g, (m) => m.replace(/[^\p{L}\p{N}_]+/gu, ' '));
  const out = new Set();
  for (const t of clean.toLowerCase().split(/[^\p{L}\p{N}_]+/u))
    if (t.length >= 3 && !/^\d+$/.test(t) && !STOP.has(t)) out.add(t);
  return out;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n);
}

/**
 * Places in a site parenthetical — `(also b.mdx:557 :600)`: a path:line is its own place, a bare `:N` a line
 * of the site's file. They place the candidate like its site (measured on a bench run: a docs drift named
 * only beside a code site clustered with nothing at the docs line).
 */
function alsoLocs(paren, file) {
  if (!paren) return [];
  const out = [...paren.matchAll(LOC_RE)].map((m) => ({
    file: m[1],
    from: +m[2],
    to: +(m[3] ?? m[2]),
  }));
  for (const m of paren.matchAll(/(?<![\w./@{}~-]):(\d+)(?:\s*[-–]\s*(\d+))?/g))
    out.push({ file, from: +m[1], to: +(m[2] ?? m[1]) });
  return out;
}

function locsOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(LOC_RE))
    out.push({ file: m[1], from: +m[2], to: +(m[3] ?? m[2]) });
  if (!out.length) {
    const f = String(text ?? '').match(FILE_RE);
    if (f && /[./]/.test(f[1]) && !/^\d/.test(f[1])) out.push({ file: f[1], from: null, to: null });
  }
  if (!out.length) {
    // a page named without extension (`ru ai-clients:256`) — last resort, so a real path always wins
    const b = String(text ?? '').match(/(?<![\w/.])([a-z][\w-]*[a-z]):(\d+)(?:-(\d+))?/i);
    if (b && !/^(https?|line|lines|port|step|round)$/i.test(b[1]))
      out.push({ file: b[1], from: +b[2], to: +(b[3] ?? b[2]) });
  }
  return out;
}

// The site field minus its leading location: `RunHistory/index.tsx:51-53 a link stays…` → `a link stays…`.
const LEAD_LOC = new RegExp(
  String.raw`^\s*[*_${'`'}]*(?:${LOC_RE.source}|${FILE_RE.source})(?:\s*,\s*:?\d+(?:\s*-\s*\d+)?)*[*_${'`'}]*[\s,;:]*`,
  'i',
);
const siteDesc = (site) =>
  String(site ?? '')
    .replace(LEAD_LOC, '')
    .trim();

const stripMd = (s) => String(s ?? '').replace(/^[*_`\s]+|[*_`\s]+$/g, '');

/** Legacy line fields → candidate, or null when no field reads as a severity. */
function legacy(fields) {
  let i0 = 0;
  let id = null;
  const head = stripMd(fields[0]);
  const glued = fields[0].trim().match(/^[*_`]*([A-Z][\w-]*\d+)[*_`]*\s+(\S.*)$/); // `**C9** agenttools_test.go`
  if (ID_RE.test(fields[0].trim()) || ID_RE.test(head)) {
    id = (fields[0].trim().match(ID_RE) ?? head.match(ID_RE))[1];
    i0 = 1;
  } else if (glued && locsOf(glued[2]).length) {
    id = glued[1];
    fields = [glued[2], ...fields.slice(1)];
  }
  if (fields.length - i0 < 3) return null;
  // The severity field: first one followed by a confidence field (or a dash), from the field after the
  // site on; else the first severity-looking field from the third on (a mechanism field sits between).
  const isSev = (i) => SEV_WORD.test(fields[i].trim());
  const confNext = (i) =>
    /^[*_`\s]*(?:confidence\s*:\s*)?(?:high|mid|medium|low|—|-|n\/a)\b/i.test(
      fields[i + 1] ?? '',
    ) || /^[*_`\s]*(?:—|-)[*_`\s]*$/.test(fields[i + 1] ?? '');
  let s = -1;
  for (let i = i0 + 1; i < fields.length && s < 0; i++) if (isSev(i) && confNext(i)) s = i;
  for (let i = i0 + 2; i < fields.length && s < 0; i++) if (isSev(i)) s = i;
  if (s < 0) return null;
  const sevWord = fields[s].trim().match(SEV_WORD)[1].toLowerCase();
  // A bare confidence word with no confidence after it is the confidence, the severity was never written
  // (gor1785 `· test gap · high · planned mutants…` read as 🔴): the candidate is a ❓.
  const confOnly = /^(high|low|medium|med|mid)$/.test(sevWord) && !confNext(s);
  const confField = confOnly ? fields[s] : (fields[s + 1] ?? '');
  const c = confField.match(CONF_WORD)?.[1]?.toLowerCase();
  const proofFrom = confOnly ? s + 1 : c ? s + 2 : s + 1;
  const site = fields[i0];
  const mechanism = fields.slice(i0 + 1, s).join(' · ');
  return {
    id,
    sev: confOnly ? '❓' : (SEV_MAP[sevWord] ?? sevWord),
    sec: /🔵/u.test(fields[s]),
    conf: c === 'medium' ? 'mid' : (c ?? '?'),
    site,
    mechanism,
    thesis: [siteDesc(site), mechanism].filter(Boolean).join(' — '),
    proof: fields.slice(proofFrom).join(' · ').trim(),
    // the lane itself cleared it (`REJECTED`, severity `none`, a trailing `· clean`): kept, flagged
    lanesRejected:
      /\bREJECTED\b|refuted/i.test(fields.join(' ')) ||
      (!confOnly && sevWord === 'none') ||
      fields.slice(proofFrom).some((f) => /^[*_`\s]*clean\b/i.test(f)),
  };
}

const legacyLine = (text) => {
  const fields = String(text).split(/\s+·\s+/);
  return fields.length >= 4 ? legacy(fields) : null;
};

const LABEL_SEV = /\bSeverity(?:\s+guess)?\s*:\s*[*_`]*\s*([A-Za-z]+)/i;
const BOLD_SEV = /\*\*(BLOCKER|CRITICAL|MAJOR|MINOR|NIT|TRIVIAL|INFO|LOW|MEDIUM|MED|HIGH)\*\*/;
/** A multi-line candidate: `- **id** · <title>` with `Site:` / `Mechanism:` / `Severity:` / `Confidence:` / `Proof:` under it. */
function labelled(body, cont) {
  const all = [body, ...cont];
  const text = all.join('\n');
  const sm = text.match(LABEL_SEV) ?? text.match(BOLD_SEV);
  const word = sm?.[1]?.toLowerCase();
  if (!word || !SEV_MAP[word]) return null;
  const label = (name) =>
    all
      .find((l) => new RegExp(`^[*_\`]*${name}\\s*:`, 'i').test(l))
      ?.replace(/^[^:]*:\s*/, '')
      .trim();
  const idm = body.match(/^[*_`]*([A-Z][\w-]*\d+)[*_`]*/);
  const title = body.replace(/^[*_`]*[A-Z][\w-]*\d+[*_`]*(?:\s*\([^)]*\))?\s*·?\s*/, '').trim();
  const c = (
    label('Confidence') ??
    text.match(/\bconfidence\s*:\s*(\w+)/i)?.[1] ??
    text.match(new RegExp(`${BOLD_SEV.source}\\s*·\\s*(\\w+)`))?.[2] ??
    ''
  )
    .match(CONF_WORD)?.[1]
    ?.toLowerCase();
  const site = label('Site') ?? title;
  return {
    id: idm?.[1] ?? null,
    sev: SEV_MAP[word],
    sec: /🔵/u.test(text),
    conf: c === 'medium' ? 'mid' : (c ?? '?'),
    site,
    mechanism: label('Mechanism') ?? '',
    thesis: [title, label('Mechanism')].filter(Boolean).join(' — '),
    proof: label('Proof') ?? text.match(/(?:PROVEN[^.\n]*|would be proven by[^\n]*)/i)?.[0] ?? '',
    lanesRejected: /\bREJECTED\b/.test(text) || word === 'none',
  };
}

/**
 * Every candidate in one lane file. `lane` defaults from the file name (`lane-A-r2.md` → A); a header
 * `# Lane X rK — …` switches lane and round for what follows (rounds appended to one file).
 */
export function parseLane(text, fileName = 'lane.md') {
  const base = path.basename(fileName);
  const fromName =
    base.match(/^lane-([A-Za-z]\d?)(?:[-_.]|$)/)?.[1]?.toUpperCase() ?? base.replace(/\.md$/i, '');
  const rFromName = +(base.match(/-r(\d+)\b/)?.[1] ?? 1);
  let lane = fromName;
  let round = rFromName;
  let section = '';
  const cands = [];
  const unparsed = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lh = line.match(/^#{1,3}[ \t]*Lane[ \t]+([A-Z]\d?)\b(.*)$/i);
    if (lh) {
      lane = lh[1].toUpperCase();
      round = +(lh[2].match(/\br(?:ound[ \t]*)?(\d+)\b/i)?.[1] ?? round);
      section = '';
      continue;
    }
    const at = `${base}:${i + 1}`;
    const nm = line.match(NEW_RE);
    if (nm) {
      const mech = [nm[5], nm[6].trim()].filter(Boolean).join(' ');
      cands.push({
        lane,
        round,
        id: nm[1],
        sev: nm[7],
        sec: Boolean(nm[8]),
        conf: nm[9],
        mechanism: mech,
        thesis: mech,
        proof: nm[10].trim(),
        locs: [{ file: nm[2], from: +nm[3], to: +(nm[4] ?? nm[3]) }, ...alsoLocs(nm[5], nm[2])],
        src: at,
        shape: 'new',
        raw: line.trim(),
      });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const bm =
        h[1].length >= 3 && BLOCK_SECTION.test(section)
          ? h[2].match(/^[*_`]*([A-Z][\w-]*\d+)[*_`]*[\s·—:-]+(🔴|🟡|🟢|❓)(🔵)?\s*(.+)$/u)
          : null;
      if (bm) {
        const where =
          lines.slice(i + 1, i + 12).find((l) => /^\s*(?:[-*]\s+)?\**Where\s*:/i.test(l)) ?? '';
        const proof = lines.slice(i + 1, i + 30).find((l) => /Evidence|Proof/i.test(l)) ?? '';
        cands.push({
          lane,
          round,
          id: bm[1],
          sev: bm[2],
          sec: Boolean(bm[3]),
          conf: '?',
          mechanism: bm[4].trim(),
          thesis: bm[4].trim(),
          proof: proof.replace(/^\s*[-*]\s+/, '').trim(),
          locs: locsOf(where),
          src: at,
          shape: 'block',
          raw: line.trim(),
        });
        continue;
      }
      // `### Probes run` under Candidates ends the section; a sub-heading of a findings block does not open one
      section = h[2];
      continue;
    }
    if (!CAND_SECTION.test(section)) continue;
    if (!/^\s*[-*]\s+\S/.test(line) || /^\s*\|/.test(line)) continue;
    const body = line.replace(/^\s*[-*]\s+/, '');
    if (/^[*_`]*clean\s*[—–-]/i.test(body)) continue;
    // Continuation: the indented lines under this bullet (sub-bullets `Site:` / `Severity:` …), a blank
    // line inside allowed when indented text follows it.
    const cont = [];
    let j = i + 1;
    while (j < lines.length) {
      if (/^\s+\S/.test(lines[j]) && !/^\s*#/.test(lines[j]))
        cont.push(lines[j].trim().replace(/^[-*]\s+/, ''));
      else if (!lines[j].trim() && /^\s+\S/.test(lines[j + 1] ?? '')) {
        /* blank inside an indented block */
      } else break;
      j++;
    }
    const c =
      legacyLine(body) ??
      (cont.length ? legacyLine([body, ...cont].join(' ')) : null) ??
      labelled(body, cont);
    if (!c) {
      if (body.split(/\s+·\s+/).length >= 2 || cont.length)
        unparsed.push({ src: at, text: body.slice(0, 200) });
      i = j - 1;
      continue;
    }
    const extra = cont.length ? [`${base}:${i + 2} ${cut(cont.join(' '), 300)}`] : [];
    cands.push({
      lane,
      round,
      ...c,
      extra,
      locs: locsOf(c.site).length ? locsOf(c.site) : locsOf(c.mechanism),
      src: at,
      shape: 'legacy',
      raw: line.trim(),
    });
    i = j - 1;
  }
  // Probe notes `- <id>: …` in the same file add proof hints to that lane's candidate.
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^\s*[-*]\s+[*_`]*([A-Z][\w-]*\d+)[*_`]*\s*:\s+(.+)$/);
    if (!pm) continue;
    const c = cands.find((x) => x.id === pm[1] && x.src !== `${base}:${i + 1}`);
    if (c) (c.extra ??= []).push(`${base}:${i + 1} ${pm[2].slice(0, 300)}`);
  }
  return { cands, unparsed };
}

// ---- clustering ----------------------------------------------------------------------------------------

/** A lane's partial path (`RunHistory/index.tsx`) → the one plan file ending with it, else as written. */
export function resolver(files = []) {
  const norm = files.map((f) => f.replace(/\\/g, '/'));
  return (p) => {
    const q = String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (!q) return q;
    if (norm.includes(q)) return q;
    const hits = norm.filter((f) => f.endsWith('/' + q));
    return hits.length === 1 ? hits[0] : q;
  };
}
/**
 * pack.diff line → { file, line at head }. Lanes cite `(pack 1910-1921)` for code they read in the pack
 * (mr1170: 7 of 20 candidates had no other site and clustered with nothing).
 */
export function packIndex(text) {
  const map = [null];
  let file = null;
  let next = null;
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const d = l.match(/^diff --git a\/(\S+) b\/(\S+)/);
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (d) {
      file = d[2];
      next = null;
    } else if (l.startsWith('+++ b/')) file = l.slice(6).trim();
    if (h) {
      next = +h[1];
      map.push({ file, line: next });
      continue;
    }
    if (next != null && !d && /^[ +]/.test(l) && !l.startsWith('+++'))
      map.push({ file, line: next++ });
    else map.push(file ? { file, line: next } : null);
  }
  return map;
}
const PACK_REF = /\bpack(?:\.diff)?\s*:?\s*(\d+)(?:\s*[-–]\s*(\d+))?/i;
function packLocs(text, map) {
  const m = String(text ?? '').match(PACK_REF);
  const a = m && map[+m[1]];
  if (!a?.file || a.line == null) return [];
  const b = map[+(m[2] ?? m[1])];
  return [
    {
      file: a.file,
      from: a.line,
      to: b?.file === a.file && b.line != null ? Math.max(a.line, b.line) : a.line,
    },
  ];
}

const sameFile = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
const near = (a, b) => {
  if (!sameFile(a.file, b.file)) return false;
  if (a.from == null || b.from == null) return a.from == null && b.from == null;
  return a.from - 3 <= b.to && b.from - 3 <= a.to;
};
const exact = (a, b) => a && b && sameFile(a.file, b.file) && a.from != null && a.from === b.from;

/**
 * Input-like backticked spans of a text (whitespace-collapsed, lowercased): a span with a space or
 * punctuation — `-j 4`, `:::`. A bare identifier (`parallel`, `readsStdin`) is left out: neighbouring
 * defects in one function cite the same names (measured: a stdin finding and an option-value finding shared two).
 */
export function codeSpans(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/`([^`\n]{2,80})`/g)) {
    const s = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
    if (!/^[\w.$]+$/u.test(s)) out.add(s);
  }
  return out;
}
const shared = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
};

/**
 * Union of candidates into clusters (union-find, transitive). Near sites join on mechanism words
 * (jaccard) or on ≥ codeMin shared input-like spans: two lanes wording one defect apart still cite the
 * same inputs (measured: `-j 4`, `--jobs 4`, `-S host`, `:::` in both, jaccard under 0.3).
 */
export function cluster(cands, { jaccardMin = 0.3, codeMin = 2 } = {}) {
  const parent = cands.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tok = cands.map((c) => tokens(`${c.thesis} ${c.mechanism}`));
  const code = cands.map((c) => codeSpans(`${c.thesis} ${c.mechanism}`));
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i];
      const b = cands[j];
      if (!a.locs.length || !b.locs.length) continue;
      const isNear = () => a.locs.some((x) => b.locs.some((y) => near(x, y)));
      const joined =
        exact(a.locs[0], b.locs[0]) ||
        (isNear() &&
          (jaccard(tok[i], tok[j]) >= jaccardMin || shared(code[i], code[j]) >= codeMin));
      if (joined) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  cands.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });
  const clusters = [...groups.values()].map((members) => {
    const sev = members.map((m) => m.sev).sort((x, y) => sevRank(x) - sevRank(y))[0];
    const best = [...members].sort(
      (x, y) =>
        (CONF_RANK[x.conf] ?? 3) - (CONF_RANK[y.conf] ?? 3) ||
        sevRank(x.sev) - sevRank(y.sev) ||
        y.thesis.length - x.thesis.length,
    )[0];
    const site = best.locs[0] ?? members.find((m) => m.locs.length)?.locs[0] ?? null;
    const lanes = [...new Set(members.map((m) => m.lane))].sort();
    return {
      sev,
      sec: members.some((m) => m.sec),
      site,
      lanes,
      thesis: best.thesis,
      conf: best.conf,
      laneRejected: members.every((m) => m.lanesRejected),
      members: members.map((m) => ({
        lane: m.lane,
        round: m.round,
        id: m.id,
        sev: m.sev,
        conf: m.conf,
        src: m.src,
        proof: m.proof,
        extra: m.extra ?? [],
        thesis: m.thesis,
        locs: m.locs,
      })),
    };
  });
  clusters.sort(
    (a, b) =>
      sevRank(a.sev) - sevRank(b.sev) ||
      (a.site?.file ?? '~').localeCompare(b.site?.file ?? '~') ||
      (a.site?.from ?? 0) - (b.site?.from ?? 0),
  );
  clusters.forEach((c, i) => (c.id = `M${String(i + 1).padStart(2, '0')}`));
  return clusters;
}

const siteText = (s) =>
  s
    ? `${s.file}${s.from != null ? `:${s.from}${s.to !== s.from ? `-${s.to}` : ''}` : ''}`
    : '(no site)';

// ---- prover groups -------------------------------------------------------------------------------------

const dirParts = (c) => (c.site?.file ?? '').split('/').slice(0, -1);
const commonDepth = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
/**
 * Non-🟢 clusters → groups of ≤ max, by directory proximity: path order keeps neighbours adjacent; the
 * number of groups is the minimum, sizes balanced; a group closes early on a jump to an unrelated tree
 * once it is at least half full.
 */
export function proverGroups(clusters, max = 6) {
  const list = clusters
    .filter((c) => c.sev !== '🟢')
    .sort(
      (a, b) =>
        (a.site?.file ?? '').localeCompare(b.site?.file ?? '') ||
        (a.site?.from ?? 0) - (b.site?.from ?? 0),
    );
  if (!list.length) return [];
  const k = Math.ceil(list.length / max);
  const target = Math.ceil(list.length / k);
  const groups = [[]];
  list.forEach((c, i) => {
    const g = groups[groups.length - 1];
    const unrelated = g.length > 0 && commonDepth(dirParts(g[0]), dirParts(c)) === 0;
    // an early close never adds a group over the minimum k: the rest must still fit the groups left
    const early =
      unrelated &&
      g.length >= Math.ceil(target / 2) &&
      list.length - i <= (k - groups.length) * max;
    const closeAt = groups.length >= k ? max : target;
    if (g.length >= closeAt || early) groups.push([c]);
    else g.push(c);
  });
  return groups.filter((g) => g.length);
}

// ---- briefs --------------------------------------------------------------------------------------------

const cut = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
};

const LADDER = [
  '## Proof ladder (live-proof.md)',
  '- **L0** — cite `file:line` at head on EVERY path the thesis spans (caller, callee, the other locale/twin); a grep with its command and count. Closes static facts only — never timing, concurrency, locks, lifecycle.',
  '- **L1** — scratch probe in the clone below: a one-file test / `node -e` / `go test -run` that goes red on the claim (at base or on an input that must fail) before its green is quoted.',
  '- **L2** — real dependencies in throwaway containers (DB semantics, error codes, locks); stop what you start in the same turn.',
  'Climb to the lowest rung that EXECUTES the behaviour; a claim above the rung you reached stays ❓.',
  '',
  '## Probe economy — every turn re-reads your whole context',
  '- A lane probe named in a hint is reused: run it as is, or copy and extend it — never rebuilt from nothing.',
  '- One probe file per cluster holds every input of its thesis (base and head, hostile and happy) and prints one line per input; one run answers the cluster.',
  '- Each needed file region is read once, in one Read with offset/limit; a cluster whose thesis is a static fact closes at L0 without a probe.',
  '- A decided cluster goes into the deliverable at once (Write first, Edit after) — the file is your memory, not the context.',
  '',
  '## Kill rule',
  'A candidate dies ONLY when its defence is shown at `file:line` on every path the thesis spans. A name, a comment, an empty grep or "probably handled" kills nothing — it stays, as ❓. Severity follows your evidence alone: the lanes\' guesses and their agreement are not evidence (the merge kept the highest guess, never raised it).',
];

const FBLOCK = [
  '## Output — one Write to the deliverable, English, exactly this shape',
  'Per surviving cluster (keep its M-id; severity = what your proof supports):',
  '```markdown',
  '### Mxx 🟡 <thesis in one line: what is broken and what it costs>',
  '',
  '- **Where:** `path:start-end` (other sites: `path2:line`)',
  '- **Axis:** correctness | frame | style',
  '- **Evidence (L1 — run):** <pasted output / file:line on every path>   ← T2: rung L1…L4, or «L0 — <why nothing ran>»',
  '- **Code:** <lines quoted from head, with path:line>',
  '- **How it was found:** 1) … 2) … 3) …',
  '- **How to reproduce:** <command / input> — Expected: … · Actual: …',
  '- **Why it matters:** <code path, input, result>   (❓: the open question instead)',
  '- **Fix:** <code change + a test that goes red without it>   (❓: the settling investigation instead)',
  '- **Status:** open',
  '```',
  'A 🔵 security finding carries both marks in the heading (`### Mxx 🟡🔵 …`).',
  'Per killed cluster, one line: `✗ Mxx — refuted: <file:line on every path> — <why the thesis fails>`.',
  'An `also (Mxx.N …)` line is a second thesis at the same site: prove it on its own and answer it as `Mxx.N` (block or ✗), or fold it into Mxx when it is the same defect.',
  'Every cluster of this brief appears exactly once: a block or a ✗ line. Nothing else in the file.',
];

const NITBLOCK = [
  '## Output — one Write to the deliverable, English, one line per cluster',
  '`- Mxx 🟢 <thesis> — **Where:** `file:line` · **Axis:** <correctness|frame|style> · **Status:** open`',
  'or `✗ Mxx — refuted: <file:line> — <why>` when the cited line at head does not say what the thesis claims.',
  'Every cluster of this brief appears exactly once. Nothing else in the file.',
];

function briefHead(p, dir, name, out, extra) {
  const head = p.headSha ?? p.head ?? '?';
  return [
    '[return-format]',
    '[no-subagents]',
    '',
    `# deep-review verify ${name} — ${p.slug ?? path.basename(dir)}${p.scope ? ` (${p.scope})` : ''}`,
    '',
    `Deliverable: ${out} — one Write, then Edit. Return ≤10 English lines: kept / killed / ❓ counts and the deliverable path.`,
    `Repo: ${p.repo ?? '?'} · base ${p.base ?? '?'} · head ${head}`,
    `Scratch clone at head (probes only; the real checkout is never written): ${p.scratch?.dir ?? 'none — L1 unavailable, say so per cluster'}`,
    p.packFile
      ? `Diff: ${p.packFile} — Read only the windows you need, never whole.`
      : `Diff: git -C ${p.repo ?? '<repo>'} diff ${p.base ?? '<base>'} ${head} -- <file>`,
    `Full cluster text and every lane hint: ${path.join(dir, 'merged.md')} (read only the M-ids below if a hint is cut).`,
    ...extra,
    '',
  ];
}

/** Cluster entries fitted to a byte budget: thesis and hints cut evenly, files named, never embedded. */
function clusterEntries(list, budget, nit) {
  const per = Math.max(nit ? 110 : 160, Math.floor(budget / Math.max(1, list.length)));
  return list.map((c) => {
    const where = [...new Set(c.members.flatMap((m) => m.locs.map(siteText)))]
      .slice(0, 6)
      .join(' · ');
    if (nit)
      return `- ${c.id} · \`${siteText(c.site)}\` · ${cut(c.thesis, per - 40)}${c.members.length > 1 ? ` · (+${c.members.length - 1} in merged.md)` : ''}${c.laneRejected ? ' · (lane already doubted it)' : ''}`;
    const hints = c.members
      .flatMap((m) => [
        m.proof
          ? `${m.lane}${m.round > 1 ? ` r${m.round}` : ''} ${m.id ?? ''} (${m.src}): ${m.proof}`
          : null,
        ...m.extra.map((e) => `${m.lane} probe ${e}`),
      ])
      .filter(Boolean);
    const hintRoom = Math.max(
      60,
      Math.floor((per * 0.45) / Math.max(1, Math.min(hints.length, 3))),
    );
    // members joined by the same file+line whose mechanism differs: each is proved on its own (Mxx.2 …)
    const own = tokens(c.thesis);
    const also = c.members.filter(
      (m) => m.thesis !== c.thesis && jaccard(own, tokens(m.thesis)) < 0.3,
    );
    return [
      `### ${c.id} ${c.sev}${c.sec ? '🔵' : ''} \`${siteText(c.site)}\` · lanes ${c.lanes.join(',')} · conf ${c.conf}${c.laneRejected ? ' · a lane already doubted it' : ''}`,
      `- thesis: ${cut(c.thesis, Math.floor(per * 0.45))}`,
      ...also.map(
        (m, k) =>
          `- also (${c.id}.${k + 2}, ${m.lane} ${m.id ?? ''} ${m.sev}): ${cut(m.thesis, Math.floor(per * 0.3))}`,
      ),
      ...(where ? [`- read: ${where}`] : []),
      ...hints.slice(0, 3).map((h) => `- hint: ${cut(h, hintRoom)}`),
      ...(hints.length > 3 ? [`- +${hints.length - 3} hints in merged.md#${c.id}`] : []),
    ].join('\n');
  });
}

export function brief(p, dir, name, list, { nit = false } = {}) {
  const out = path.join(dir, `${name}.out.md`);
  const extra = nit
    ? [
        '',
        'Cite-only pass (L0): open each cited line at head, confirm the line says what the thesis claims; no probes.',
      ]
    : [
        '',
        `Clusters below: ${list.map((c) => c.id).join(', ')}. Prove each one — they are independent; a lane hint is a lead, not evidence.`,
      ];
  const head = briefHead(p, dir, name, out, extra).join('\n');
  const tail = ['', ...(nit ? NITBLOCK : [...LADDER, '', ...FBLOCK]), ''].join('\n');
  const fixed = Buffer.byteLength(head + tail + '\n## Clusters\n\n', 'utf8');
  let room = BRIEF_TARGET - fixed - 64;
  const compose = () =>
    `${head}\n## Clusters\n\n${clusterEntries(list, room, nit).join('\n\n')}\n${tail}`;
  let text = compose();
  // Bytes, not chars: Cyrillic is 2 bytes. Shrink until it fits or the floor is reached.
  for (let i = 0; i < 8 && Buffer.byteLength(text, 'utf8') > BRIEF_TARGET; i++) {
    room = Math.floor(room * 0.75);
    text = compose();
  }
  return { file: path.join(dir, `${name}.prompt.md`), out, text };
}

export const stub = (file) =>
  `Your full brief is ${file} — Read it first, in one Read.\n[return-format]\n[no-subagents]`;

// ---- merged.md -----------------------------------------------------------------------------------------

function mergedMd(p, dir, clusters, perLane, unparsed) {
  const raw = clusters.reduce((n, c) => n + c.members.length, 0);
  const by = SEV_ORDER.map((s) => `${s} ${clusters.filter((c) => c.sev === s).length}`).join(' · ');
  const out = [
    `# Merged candidates — ${p.slug ?? path.basename(dir)}`,
    '',
    `raw ${raw} candidates (${Object.entries(perLane)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}) → ${clusters.length} clusters (${by}); agreement never raised a severity; nothing dropped.`,
    `base ${p.base ?? '?'} · head ${p.headSha ?? p.head ?? '?'}`,
    '',
  ];
  for (const c of clusters) {
    out.push(`## ${c.id} ${c.sev}${c.sec ? '🔵' : ''} ${siteText(c.site)}`, '');
    out.push(
      `- lanes: ${c.lanes.join(', ')} · members ${c.members.length} · conf ${c.conf}${c.laneRejected ? ' · every member already doubted by its lane' : ''}`,
    );
    out.push(`- mechanism: ${c.thesis}`);
    for (const m of c.members) {
      out.push(
        `- ${m.lane} r${m.round} ${m.id ?? '(no id)'} · ${m.sev} · ${m.conf} · ${m.src}${m.thesis !== c.thesis ? ` · ${m.thesis}` : ''}`,
      );
      if (m.proof) out.push(`  - hint: ${m.proof}`);
      for (const e of m.extra) out.push(`  - probe: ${e}`);
    }
    out.push('');
  }
  if (unparsed.length) {
    out.push(
      '## Lines in candidate sections not read as candidates (no severity field) — check by eye',
      '',
    );
    for (const u of unparsed) out.push(`- ${u.src}: ${u.text}`);
    out.push('');
  }
  return out.join('\n');
}

// ---- io helpers ----------------------------------------------------------------------------------------

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}
export function laneFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^lane-.*\.md$/i.test(f) && !/\.prompt\.md$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}
function planPath(dir, given) {
  if (given && given !== true) return path.resolve(String(given));
  for (const c of [path.join(dir, 'plan', 'plan.json'), path.join(dir, 'plan.json')])
    if (existsSync(c)) return c;
  throw new Error(`no plan.json under ${dir} — pass --plan`);
}

export function merge(dir, o = {}) {
  const planFile = planPath(dir, o.plan);
  const p = JSON.parse(readFileSync(planFile, 'utf8'));
  const resolve = resolver(p.files ?? []);
  const pmap =
    p.packFile && existsSync(p.packFile) ? packIndex(readFileSync(p.packFile, 'utf8')) : null;
  const files = laneFiles(dir);
  if (!files.length) throw new Error(`no lane-*.md in ${dir}`);
  const all = [];
  const unparsed = [];
  const perLane = {};
  for (const f of files) {
    const r = parseLane(readFileSync(f, 'utf8'), f);
    for (const c of r.cands) {
      if (!c.locs.length && pmap) c.locs = packLocs(`${c.site ?? ''} ${c.thesis}`, pmap);
      c.locs = c.locs.map((l) => ({ ...l, file: resolve(l.file) }));
      perLane[`${c.lane} r${c.round}`] = (perLane[`${c.lane} r${c.round}`] ?? 0) + 1;
    }
    all.push(...r.cands);
    unparsed.push(...r.unparsed);
  }
  const clusters = cluster(all);
  // 6: cost per cluster is U-shaped. Measured: an 8-cluster prover ran 67 turns, 4.98M tokens, 44 min
  // (every turn carries every earlier cluster's probes). Bench, same 10 clusters: 5+5 → 2.91M / 7.1 min,
  // 4+3+3 → 3.58M / 6.7 min — a spawn's own base context outweighs the shorter tail.
  const max = Math.max(1, +(o['max-per-prover'] ?? 6));
  const groups = proverGroups(clusters, max);
  const nits = clusters.filter((c) => c.sev === '🟢');
  const briefs = groups.map((g, i) => ({
    ...brief(p, dir, `prove-${i + 1}`, g),
    ids: g.map((c) => c.id),
  }));
  // All 🟢 go to ONE cite-only brief; only past --max-nits (a brief over the 8 KB target at the floor
  // entry size — gor1785: 184 nits = 25 KB) are they split, in path order, into prove-nits-<k>.
  const maxNits = Math.max(1, +(o['max-nits'] ?? 40));
  const nitParts = Math.ceil(nits.length / maxNits);
  const byPath = [...nits].sort(
    (a, b) =>
      (a.site?.file ?? '').localeCompare(b.site?.file ?? '') ||
      (a.site?.from ?? 0) - (b.site?.from ?? 0),
  );
  for (let k = 0; k < nitParts; k++) {
    const part = byPath.slice(
      Math.floor((k * nits.length) / nitParts),
      Math.floor(((k + 1) * nits.length) / nitParts),
    );
    briefs.push({
      ...brief(p, dir, nitParts === 1 ? 'prove-nits' : `prove-nits-${k + 1}`, part, { nit: true }),
      ids: part.map((c) => c.id),
    });
  }
  writeFileSync(path.join(dir, 'merged.md'), mergedMd(p, dir, clusters, perLane, unparsed));
  writeFileSync(
    path.join(dir, 'merged.json'),
    JSON.stringify(
      { planFile, clusters, briefs: briefs.map((b) => ({ file: b.file, out: b.out, ids: b.ids })) },
      null,
      1,
    ),
  );
  for (const b of briefs) writeFileSync(b.file, b.text);
  return { raw: all.length, clusters, briefs, unparsed, perLane };
}

// ---- assemble ------------------------------------------------------------------------------------------

// `Mxx.2`: a second thesis of one cluster (members sharing a site, not a mechanism) proved on its own.
const BLOCK_HEAD = /^#{2,4}\s+(M\d+(?:\.\d+)?)\s+(\S+)\s*(.*)$/u;
const NIT_LINE = /^\s*[-*]\s+[*_`]*(M\d+(?:\.\d+)?)[*_`]*\s+(\S*🟢\S*)\s+(.*)$/u;
const KILL_LINE = /^\s*(?:[-*]\s+)?✗\s*[*_`]*(M\d+(?:\.\d+)?)[*_`]*\s*[—–:-]+\s*(.*)$/u;
const baseId = (id) => id.split('.')[0];

/** Blocks, one-line nits and kills of one prover output. */
export function parseProver(text) {
  const blocks = [];
  const nits = [];
  const kills = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const k = line.match(KILL_LINE);
    if (k) {
      cur = null;
      kills.push({ id: k[1], text: k[2].trim() });
      continue;
    }
    const n = line.match(NIT_LINE);
    if (n) {
      cur = null;
      nits.push({ id: n[1], marks: n[2], line: line.trim() });
      continue;
    }
    const b = line.match(BLOCK_HEAD);
    if (b) {
      cur = {
        id: b[1],
        marks: b[2],
        sev: SEV_ORDER.find((s) => b[2].includes(s)) ?? '❓',
        sec: b[2].includes('🔵'),
        lines: [line],
      };
      blocks.push(cur);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  for (const b of blocks)
    while (b.lines.length && !b.lines[b.lines.length - 1].trim()) b.lines.pop();
  return { blocks, nits, kills };
}

/** A cluster no prover answered: kept as ❓ (non-🟢) or as its nit line — nothing is dropped. */
function fallbackBlock(c) {
  if (c.sev === '🟢')
    return {
      id: c.id,
      sev: '🟢',
      nit: true,
      line: `- ${c.id} 🟢 ${cut(c.thesis, 200)} — **Where:** \`${siteText(c.site)}\` · **Axis:** undetermined — no prover answered · **Status:** open`,
    };
  return {
    id: c.id,
    sev: '❓',
    sec: c.sec,
    lines: [
      `### ${c.id} ❓${c.sec ? '🔵' : ''} ${cut(c.thesis, 200)}`,
      '',
      `- **Where:** \`${siteText(c.site)}\``,
      '- **Axis:** correctness',
      `- **Evidence (L0 — no prover returned output for this candidate):** lane hints — ${
        cut(
          c.members
            .map((m) => m.proof)
            .filter(Boolean)
            .join(' · '),
          400,
        ) || 'none'
      }`,
      `- **Why it matters:** the question stays open: candidate ${c.lanes.join(', ')} was neither confirmed nor refuted.`,
      '- **Fix:** prove it up the L0–L2 ladder or refute it with `file:line` on every path.',
      '- **Status:** open',
    ],
  };
}

/** Header values from a fill file: `**Key:** value` lines (whole line replaces the skeleton's) and `## Section` bodies. */
export function readFill(text) {
  const lines = {};
  const sections = {};
  let sec = null;
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const k = l.match(/^\*\*([^*:]+):\*\*/);
    const s = l.match(/^##\s+(.+?)\s*$/);
    if (s) {
      sec = s[1];
      sections[sec] = [];
    } else if (k && !sec) lines[k[1].trim()] = l;
    else if (sec) sections[sec].push(l);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return { lines, sections };
}

// ---- passes ----------------------------------------------------------------------------------------------
// Each lane answers SKILL §3's hunt passes and axis-1's six miss classes under `## Passes` (English keys,
// review-plan PASS_HINTS); the report's «Passes» / «Classes» lines carry the keys the hook demands (the lane
// key `before-gate` is the report's `before gate`). Measured on a bench run: the report writer re-read every
// lane file for these lines.
export const PASS_KEYS = [
  ['promises', 'promises'],
  ['config', 'config'],
  ['parse', 'parse'],
  ['registries', 'registries'],
  ['deviance', 'deviance'],
  ['claims', 'claims'],
  ['history', 'history'],
  ['attacker', 'attacker'],
];
export const CLASS_KEYS = [
  ['siblings', 'siblings'],
  ['parity', 'parity'],
  ['hang', 'hang'],
  ['before-gate', 'before gate'],
  ['environment', 'environment'],
  ['contract', 'contract'],
];
const PASS_ROW = /^\s*[-*]\s+[*_`]*(\p{L}[\p{L} -]*?)[*_`]*\s*(?::|—|–)\s*(.+)$/u;

/** `## Passes` of one lane file → Map(key lowercased → answer); lane or report keys, first answer wins. */
export function parsePasses(text) {
  const out = new Map();
  let on = false;
  for (const l of String(text ?? '').split(/\r?\n/)) {
    if (/^#{1,4}\s/.test(l)) {
      on = /^#{1,4}\s+passes\b/iu.test(l);
      continue;
    }
    const m = on ? l.match(PASS_ROW) : null;
    const key = m?.[1].trim().toLowerCase();
    if (key && !out.has(key)) out.set(key, m[2].trim());
  }
  return out;
}

/** `A r2` for a lane file — the same lane/round parseLane gives its candidates (header first, else the name). */
export function laneLabel(text, fileName = 'lane.md') {
  const base = path.basename(fileName);
  const h = String(text ?? '').match(/^#{1,3}[ \t]*Lane[ \t]+([A-Z]\d?)\b(.*)$/im);
  const lane =
    h?.[1].toUpperCase() ??
    base.match(/^lane-([A-Za-z]\d?)(?:[-_.]|$)/)?.[1]?.toUpperCase() ??
    base.replace(/\.md$/i, '');
  const round = +(
    h?.[2].match(/\br(?:ound[ \t]*)?(\d+)\b/i)?.[1] ??
    base.match(/-r(\d+)\b/)?.[1] ??
    1
  );
  return `${lane} r${round}`;
}

/**
 * The «**Passes:**» / «**Classes:**» lines from the lanes' `## Passes`; null when no lane answered any key
 * of that line (the skeleton's blanks stay). Per key: the answers that are not n/a, up to 3, each with its
 * lane label; all n/a → the first one; no lane at all → a blank the hook refuses. `rename(label, text)`
 * turns a lane's C-id into its F-id.
 */
export function passLines(lanes, rename = (_, s) => s) {
  const per = lanes.map((l) => ({ label: l.label, ans: parsePasses(l.text) }));
  const build = (title, keys) => {
    let any = false;
    const parts = keys.map(([key, name]) => {
      const hits = per
        .map((x) => ({ label: x.label, a: x.ans.get(key) ?? x.ans.get(name) }))
        .filter((x) => x.a);
      if (!hits.length) return `${name} — ⟨fill: no lane answered⟩`;
      any = true;
      const real = hits.filter((x) => !/^n\/?a\b/i.test(x.a));
      const pick = (real.length ? real : hits).slice(0, 3);
      return `${name} — ${pick.map((x) => `${cut(rename(x.label, x.a).replace(/\s+·\s+/g, '; '), 160)} (${x.label})`).join('; ')}`;
    });
    return any ? `**${title}:** ${parts.join(' · ')}` : null;
  };
  return { passes: build('Passes', PASS_KEYS), classes: build('Classes', CLASS_KEYS) };
}

export function assemble(o) {
  const dir = path.resolve(String(o.dir));
  const planFile = planPath(dir, o.plan);
  const merged = JSON.parse(readFileSync(path.join(dir, 'merged.json'), 'utf8'));
  const byId = new Map(merged.clusters.map((c) => [c.id, c]));
  const outs = o._?.length
    ? o._.map((f) => path.resolve(f))
    : readdirSync(dir)
        .filter((f) => /^prove-.*\.out\.md$/.test(f))
        .sort()
        .map((f) => path.join(dir, f));
  const warnings = [];
  const blocks = [];
  const kills = [];
  const seen = new Set();
  for (const f of outs) {
    const r = parseProver(readFileSync(f, 'utf8'));
    for (const b of r.blocks) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      blocks.push(b);
    }
    for (const n of r.nits) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      blocks.push({ id: n.id, sev: '🟢', nit: true, line: n.line });
    }
    for (const k of r.kills) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      kills.push(k);
    }
  }
  const answered = new Set([...seen].map(baseId));
  for (const c of merged.clusters) {
    if (answered.has(c.id)) continue;
    warnings.push(
      `${c.id} (${c.sev} ${siteText(c.site)}) — no prover answered; kept as ${c.sev === '🟢' ? '🟢 line' : '❓'}`,
    );
    blocks.push(fallbackBlock(c));
  }
  for (const id of seen)
    if (!byId.has(baseId(id))) warnings.push(`${id} — in a prover output but not in merged.json`);
  // Report order: 🔵 block first, then 🔴 🟡 ❓, then 🟢; within a severity the merge order (numeric).
  const order = (b) => (b.sev !== '🟢' && b.sec ? -1 : sevRank(b.sev));
  const num = (id) => id.slice(1).split('.').map(Number);
  blocks.sort(
    (a, b) =>
      order(a) - order(b) ||
      num(a.id)[0] - num(b.id)[0] ||
      (num(a.id)[1] ?? 0) - (num(b.id)[1] ?? 0),
  );
  const fid = new Map(blocks.map((b, i) => [b.id, `F-${String(i + 1).padStart(2, '0')}`]));
  const ren = (s) => s.replace(/\bM\d{2,}(?:\.\d+)?\b/g, (m) => fid.get(m) ?? m);
  const findings = [];
  const nitLines = [];
  for (const b of blocks) {
    if (b.nit) nitLines.push(ren(b.line));
    else
      findings.push(
        b.lines
          .map((l, i) =>
            i === 0
              ? l.replace(
                  BLOCK_HEAD,
                  (_, id, marks, rest) => `### ${fid.get(id)} ${marks} ${ren(rest)}`,
                )
              : ren(l),
          )
          .join('\n'),
      );
  }
  const killLines = kills.map((k) => {
    const c = byId.get(baseId(k.id));
    return `- ✗ ${k.id} \`${siteText(c?.site)}\` ${cut(c?.thesis ?? '', 140)} — ${k.text}`;
  });

  // Skeleton from review-plan.mjs, run as a process (its owner may change it; the shape stays its own).
  const lanes = laneFiles(dir);
  const p = JSON.parse(readFileSync(planFile, 'utf8'));
  const skArgs = [PLAN_TOOL, 'skeleton', '--plan', planFile, ...lanes];
  if (o.tier && o.tier !== true) skArgs.push('--tier', String(o.tier));
  const title = o.title && o.title !== true ? String(o.title) : p.scope;
  if (title) skArgs.push('--title', title);
  const sk = spawnSync(process.execPath, skArgs, { encoding: 'utf8' });
  if (sk.status !== 0) throw new Error(`review-plan skeleton failed: ${sk.stderr || sk.stdout}`);
  let lines = sk.stdout.replace(/\r/g, '').replace(/\n+$/, '').split('\n');

  const fill =
    o.fill && o.fill !== true
      ? readFill(readFileSync(String(o.fill), 'utf8'))
      : { lines: {}, sections: {} };
  lines = lines.map((l) => {
    const k = l.match(/^\*\*([^*:]+):\*\*/)?.[1]?.trim();
    return k && fill.lines[k] ? fill.lines[k] : l;
  });
  const dropped = kills.length
    ? `**Dropped:** ${kills.length} of ${merged.clusters.length} candidates refuted by the provers — the «✗» lines in «What was checked»`
    : `**Dropped:** none — the provers refuted none of the ${merged.clusters.length} candidates`;
  if (!fill.lines['Dropped']) lines = lines.map((l) => (/^\*\*Dropped:\*\*/.test(l) ? dropped : l));
  // «Passes» / «Classes» from the lanes' `## Passes` unless the fill gives them; a C-id becomes its F-id.
  const memberOf = new Map();
  for (const c of merged.clusters)
    for (const m of c.members ?? []) memberOf.set(`${m.lane} r${m.round} ${m.id}`, c.id);
  const rename = (label, s) =>
    s.replace(/\bC-?[A-Z][\w-]*?\d+\b/g, (cid) => fid.get(memberOf.get(`${label} ${cid}`)) ?? cid);
  const pl = passLines(
    lanes.map((f) => {
      const t = readFileSync(f, 'utf8');
      return { label: laneLabel(t, f), text: t };
    }),
    rename,
  );
  for (const [key, val] of [
    ['Passes', pl.passes],
    ['Classes', pl.classes],
  ])
    if (!fill.lines[key] && val) lines = lines.map((l) => (l.startsWith(`**${key}:**`) ? val : l));

  const put = (heading, body) => {
    const i = lines.findIndex((l) => l.trim() === `## ${heading}`);
    if (i < 0 || !body.length) return;
    lines.splice(i + 1, 0, '', ...body);
  };
  // Insert bottom-up so earlier indexes stay valid.
  put('Nits', nitLines);
  for (const name of ['Done well', 'Out of scope'])
    if (fill.sections[name]) put(name, [fill.sections[name]]);
  put(
    'Findings',
    findings.flatMap((f) => [f, '']),
  );
  if (fill.sections['Verdict on the stated'])
    put('Verdict on the stated', [fill.sections['Verdict on the stated']]);
  put('What was checked', [
    ...(fill.sections['What was checked'] ? [fill.sections['What was checked'], ''] : []),
    ...killLines,
  ]);

  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  const computed = scoreLines(parseReport(text));
  text = text
    .replace(/^\*\*Summary:\*\*.*$/m, computed.itog)
    .replace(/^\*\*Score:\*\*.*$/m, computed.score);
  const problems = writeProblems(text);
  const out = path.resolve(String(o.out));
  const written = problems.length ? out.replace(/(\.agent)?\.md$/i, '') + '.draft.md' : out;
  mkdirSync(path.dirname(written), { recursive: true });
  writeFileSync(written, text);
  return { written, problems, warnings, findings: blocks.length, kills: kills.length, text };
}

// ---- cli -----------------------------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (cmd === 'merge') {
    if (!o.dir || o.dir === true) throw new Error('merge needs --dir <review dir>');
    const dir = path.resolve(String(o.dir));
    const r = merge(dir, o);
    const by = SEV_ORDER.map((s) => `${s} ${r.clusters.filter((c) => c.sev === s).length}`).join(
      ' · ',
    );
    console.log(
      `raw ${r.raw} candidates (${Object.entries(r.perLane)
        .map(([k, v]) => `${k} ${v}`)
        .join(
          ', ',
        )}) → ${r.clusters.length} clusters (${by})${r.unparsed.length ? `; ${r.unparsed.length} candidate-section lines without a severity listed at the end of merged.md` : ''}`,
    );
    console.log(`→ ${path.join(dir, 'merged.md')}`);
    for (const b of r.briefs) {
      const kb = Buffer.byteLength(b.text, 'utf8');
      console.log(
        `→ ${b.file} (${(kb / 1024).toFixed(1)} KB, ${b.ids.length} clusters: ${b.ids.join(' ')})${kb > BRIEF_TARGET ? ' — OVER the 8 KB target: lower --max-per-prover' : ''}`,
      );
    }
    console.log('spawn (lane-high, one per brief, in parallel):');
    for (const b of r.briefs) {
      const name = path.basename(b.file).replace(/\.prompt\.md$/, '');
      console.log(`--- description: deep-review verify ${name}\n${stub(b.file)}`);
    }
    console.log(
      `then: node ${path.join(HERE, 'review-merge.mjs')} assemble --dir ${dir} --plan ${planPath(dir, o.plan)} --out <repo>/.agent/reviews/<slug>.agent.md --fill <header.md>`,
    );
    return 0;
  }
  if (cmd === 'assemble') {
    if (!o.dir || o.dir === true || !o.out || o.out === true)
      throw new Error('assemble needs --dir <review dir> --out <report>');
    const r = assemble(o);
    for (const w of r.warnings) console.log(`warn: ${w}`);
    console.log(`findings ${r.findings} · kills ${r.kills}`);
    if (r.problems.length) {
      console.log(`gate: REFUSED (${r.problems.length}) — written as draft ${r.written}`);
      for (const p of r.problems) console.log(`  - ${p}`);
      return 1;
    }
    console.log(
      `gate: pass (hooks/lib/review-report.mjs writeProblems → 0 problems) → ${r.written}`,
    );
    return 0;
  }
  console.error(
    'usage: review-merge.mjs merge --dir <review dir> [--plan plan.json] [--max-per-prover 6] [--max-nits 40] | assemble --dir <review dir> --plan plan.json --out <report.agent.md> [--fill header.md] [--tier T2] [--title "…"] [prover outputs…]',
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`review-merge: ${e.message}`);
    process.exitCode = 2;
  }
}
