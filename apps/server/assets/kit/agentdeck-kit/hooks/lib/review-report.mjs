// The review report is a work list a fix agent runs from unattended, and its header is what makes the
// review's bar tunable. An audit over 34 real reports found the tier line in 0 of 34 and the score
// line in 7 of 34: the shape was prose in references/report-shape.md and nothing else enforced it.
// Keys and the structured lines are fixed English tokens (one parser for every tool); the prose of a
// finding is in the user's language.
//
// Three consumers, one parser: this PreToolUse guard, `tools/review-score.mjs`, which prints or writes
// the `Summary` / `Score` lines — a number in a header is computed from the findings, never typed — and
// `tools/review-sync.mjs`, which edits finding blocks by the boundaries parsed here.
//
// Write (whole content) → full check. Edit → no regression only: a fix agent flipping one `Status` in a
// legacy report must not be made to retrofit a header it cannot know (the tier of a month-old review).
// A report written AROUND the guard — a Bash heredoc, a script — is judged at Stop instead
// (`reviewReportAtStop`, run by the Stop dispatcher): a report with `###` ids once came in that way and
// nothing saw it.
// Kill-switch: AGENTDECK_KIT_REVIEW_REPORT_GUARD=0 (CLAUDE_REVIEW_REPORT_GUARD=0 too).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  lastUserSpeech,
  inSubagent,
} from './transcript.mjs';

const REPORT_PATH = /[\\/]\.agent[\\/]reviews[\\/][^\\/]+\.agent\.md$/i;
export const isReviewReport = (filePath) => REPORT_PATH.test(String(filePath ?? ''));

const OFF = () =>
  process.env.AGENTDECK_KIT_REVIEW_REPORT_GUARD === '0' ||
  process.env.CLAUDE_REVIEW_REPORT_GUARD === '0';
const SEVERITY = ['🔴', '🟡', '🟢', '❓'];
/** Header lines every report carries. `hint` is what the deny tells the writer to put there. */
const REQUIRED = [
  {
    key: 'Tier',
    re: /^\*\*Tier:\*\*\s*T[0-2](?!\d)/m,
    hint: '**Tier:** T0|T1|T2 — <markers printed by <kit>/tools/risk-tier.mjs>',
  },
  {
    key: 'Radius',
    re: /^\*\*Radius:\*\*\s*\S/m,
    hint: '**Radius:** <the radius summary risk-tier.mjs printed: consumers · entry points · what fell over the cap — or why it was not computed>',
  },
  // The two honesty lines: what the run actually executed, and what it could not. The skeleton in
  // report-shape.md has carried both since the start; nothing enforced them, and a report that
  // states neither reads as if everything under it was verified.
  {
    key: 'Verified',
    re: /^\*\*Verified:\*\*\s*\S/m,
    hint: '**Verified:** <commands actually run; files actually read>',
  },
  {
    key: 'Taken on trust',
    re: /^\*\*Taken on trust:\*\*\s*\S/m,
    hint: '**Taken on trust:** <what could not be checked and why — `none` when everything was>',
  },
  { key: 'Score', re: /^\*\*Score:\*\*\s*\S/m, hint: null /* computed below */ },
];

/** Per-finding fields the skeleton demands. A finding missing one is not a work list entry. */
const FIELD = {
  axis: /^\s*(?:[-*]\s+)?\*{0,2}Axis\s*:\*{0,2}\s*(\S.*)$/i,
  where: /^\s*(?:[-*]\s+)?\*{0,2}Where\s*:\*{0,2}\s*\S/i,
  evidence: /^\s*(?:[-*]\s+)?\*{0,2}Evidence/i,
};
/** The tier the report claims for itself — the only place the guard can read it. */
const TIER_LINE = /^\*\*Tier:\*\*\s*(T[0-2])(?!\d)/m;
/**
 * A bold header field and its value: the line PLUS its wrapped continuation lines, up to a blank line,
 * a fence, or a line opening with a marker (`*` — the next `**Field:**` —, `-`, `+`, `#`, `>`).
 * report-shape's own skeleton wraps `Classes` over three lines; read one line deep, the guard refused
 * the documented shape.
 */
const field = (name) =>
  new RegExp(
    String.raw`^\*\*${name}:\*\*[ \t]*(\S.*(?:\r?\n(?![ \t]*(?:[-*+#>]|` +
      '```' +
      String.raw`|\r?$)).*)*)`,
    'm',
  );
/** The line that makes a live run checkable instead of self-reported. */
const LIVE_LINE = field('Live');
/** "nothing ran" is an allowed answer — an unrunnable check is reported as not done, never as done. */
const LIVE_NOT_RUN =
  /not run|could not (?:be )?run|stand (?:unavailable|down)|no stand|nothing to run|not reproducible locally/i;
/**
 * The four variation classes of the live-check rule, in the wording risk-tier prints for T2.
 * T2 owes TWO OF DIFFERENT CLASSES: picking the two cheapest to stage is how a hard tier turns into
 * two happy paths with different data. Matching is on the `Live` line alone, never on the whole
 * report — a word met somewhere in a finding is not a run.
 */
const VARIATIONS = [
  {
    key: 'delay',
    re: /delay|timeout|race|slow|parallel|concurren|repeat\w* (?:submit|click)|double[- ]?click|offline/i,
  },
  {
    key: 'role without the right',
    re: /\brole|no (?:right|permission|access)|unauthori|forbidden|403|permission|guest|another user/i,
  },
  {
    key: 'empty state',
    re: /empty|zero (?:rows|items)|no rows|\bmax|limit|very long|many (?:rows|items)|boundary|overflow/i,
  },
  {
    key: 'bad input',
    re: /bad input|invalid|garbage|broken|malformed|injection|special char|xss|sql/i,
  },
];
/** "nothing died under proof" has to be said out loud — silence is how a zero kill rate hides. */
const NO_KILLS_DECLARED = /^\*\*Dropped:\*\*\s*\S/m;

const STATUS_SHAPES = [
  /\*\*Status\s*:\*\*\s*`?([a-z_-]+)/i, // **Status:** open
  /\*\*Status\s*:\s*`?([a-z_-]+)`?[^*\n]*\*\*/i, // **Status: open** · **Status: stale (closed, MR merged)**
  /^\s*(?:[-*]\s+)?Status\s*:\s*`?([a-z_-]+)/i, // Status: open · path
];
/**
 * Statuses that count as confirmed by the author. `accepted` = the author agreed in the thread (review-sync
 * reads it back, unverified); `fixed` = the reviewer re-ran the evidence. Both are "confirmed by author".
 */
const CONFIRMED = new Set(['accepted', 'fixed']);

/** The line that answers the six miss classes of axis-1 — one key each, a command or `file:line` behind it. */
const CLASSES_LINE = field('Classes');
const MISS_CLASSES = ['siblings', 'parity', 'hang', 'before gate', 'environment', 'contract'];

/**
 * The coverage ledger (SKILL §1): per zone read fully · partly · not, and whether the radius was cut.
 * A real report once said "no blocking findings" over zones nobody opened. A gap is any unread or partly read zone, or a
 * radius printed as not searched — and while one stands, no line may claim the change clean.
 */
const COVERAGE_LINE = field('Coverage');
const COVERAGE_GAP = /not\s*read|unread|not\s*opened|partly|partial|not\s*walked|not\s*searched|✗/i;
const CLEAN_CLAIM =
  /no\s+blocking|nothing\s+blocking|blocking\s*(?:findings\s*)?:\s*none|(?:ready|safe|ok)\s+to\s+merge|\bLGTM\b|\bapprove\b/i;
const CLAIM_QUALIFIED =
  /in\s+what\s+was\s+read|coverage\s+incomplete|except\s+(?:zones|unread)|not\s+read/i;
/** The hunt passes of SKILL §2, one key each — a command, `file:line`, or "n/a — <the search>". */
const PASSES_LINE = field('Passes');
const HUNT_PASSES = [
  'promises',
  'config',
  'parse',
  'registries',
  'deviance',
  'claims',
  'history',
  'attacker',
];
/** The acceptance matrix of axis-2 (g), counted — or "no frame" with what was searched. */
const ACCEPT_LINE = field('Acceptance');
/**
 * The lane ledger, as `review-plan.mjs check` prints it: changed files with a ledger row / planned.
 * A blind run once had both lanes stop at ~100 tool calls with half the zone unread and write their
 * findings anyway. A short count is a coverage gap like an unread zone.
 */
const JOURNAL_LINE = field('Ledger');
const JOURNAL_COUNT = /(\d+)\s*\/\s*(\d+)/;
const JOURNAL_NONE = /no lanes\s*[—–-]\s*\S/i;
/** A T2 🔴/🟡 names its proof rung: L1–L4 executed, or "L0 — <why nothing ran>". */
const RUNG_RUN = /\bL[1-4]\b/;
const RUNG_L0_WHY = /\bL0\s*[—–-]\s*\S/;

/** `file:line[-line]` in a `Where` / legacy `Status` line; an elided `.../` or a `{a,b}` segment is kept as written. */
const LOC = /`?((?:[\w.@{},~…-]+\/)+[\w.@{},~…-]+|[\w@{},~-]+\.[a-z0-9{},]+):(\d+)(?:-(\d+))?`?/gi;
const WHERE_LINE = /^\s*(?:[-*]\s+)?\*{0,2}Where\s*(?::|\*\*)/i;
const LEGACY_WHERE = /^\s*(?:[-*]\s+)?\*{0,2}Status\s*:/i; // `Status: open · path:line`
const FIELD_START = /^\s*[-*]\s+\*\*|^\s*$/;

/**
 * Findings, the killed candidates and the header numbers, from the report text. The single parser of a
 * report: this guard, `tools/review-score.mjs` and `tools/review-sync.mjs` all read through it, so a
 * status or a block boundary means one thing everywhere. Per finding: `start`/`end` line indexes (the
 * block runs to the next finding or `#`/`##` heading), `statusAt`/`threadUrl`/`whereEnd` for edits.
 */
export function parseReport(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  const findings = [];
  let current = null;
  let inWhere = false;
  lines.forEach((line, i) => {
    const h = line.match(/^#{2,4}\s+(F-\d+)[\s·—:-]+(\S+)[\s·—:-]*(.*)$/);
    if (h) {
      if (current) current.end = i;
      current = {
        id: h[1],
        marks: h[2],
        severity: SEVERITY.find((s) => h[2].includes(s)) ?? null,
        thesis: h[3].trim(),
        start: i,
        end: lines.length,
        status: null,
        statusAt: -1,
        thread: false,
        threadUrl: null,
        axis: null,
        where: false,
        whereEnd: -1,
        evidence: false,
        locs: [],
        rung: false,
      };
      findings.push(current);
      inWhere = false;
      return;
    }
    if (/^#{1,2}\s/.test(line) && current) {
      current.end = i; // a section heading closes the finding above it
      current = null;
    }
    if (!current) return;
    // Every spelling found on disk. Bold is unambiguous anywhere in a line; the bare word counts only
    // at the start of one, or "status and role come from the token" would be read as a status.
    const st = STATUS_SHAPES.map((re) => line.match(re)).find(Boolean);
    if (st) {
      current.status = st[1].toLowerCase();
      current.statusAt = i;
    }
    const t = line.match(/^\s*(?:[-*]\s+)?\*{0,2}Thread\s*:\s*\*{0,2}\s*(\S+)/i);
    if (t) {
      current.thread = true;
      current.threadUrl ??= t[1];
    }
    const ax = line.match(FIELD.axis);
    if (ax && !current.axis) current.axis = ax[1].replace(/\*/g, '').trim().toLowerCase();
    if (FIELD.where.test(line)) current.where = true;
    if (FIELD.evidence.test(line)) current.evidence = true;
    if (RUNG_RUN.test(line) || RUNG_L0_WHY.test(line)) current.rung = true;
    // Locations: the `Where` line and its indented continuation lines, until the next field or a blank.
    if (WHERE_LINE.test(line)) inWhere = 'where';
    else if (LEGACY_WHERE.test(line)) inWhere = 'legacy';
    else if (FIELD_START.test(line)) inWhere = false;
    if (inWhere === 'where') current.whereEnd = i; // edits go below the last continuation line
    if (inWhere)
      for (const m of line.matchAll(LOC))
        current.locs.push({ file: m[1], from: +m[2], to: +(m[3] ?? m[2]) });
  });
  // A candidate that died under proof: one `- ✗ …` line in "What was checked". It is part of `raised`.
  const killed = lines.filter((l) => /^\s*[-*]\s*✗\s/.test(l)).length;
  const bySeverity = Object.fromEntries(
    SEVERITY.map((s) => [s, findings.filter((f) => f.severity === s).length]),
  );
  return {
    findings,
    coverageGap: COVERAGE_GAP.test(COVERAGE_LINE.exec(src)?.[1] ?? '') || journalShort(src),
    killed,
    bySeverity,
    blocking: findings.filter((f) => f.severity === '🔴').map((f) => f.id),
    published: findings.filter((f) => f.thread).length,
    confirmed: findings.filter((f) => CONFIRMED.has(f.status)).length,
    open: findings.filter((f) => !f.status || f.status === 'open').length,
  };
}

/** The two computed header lines. */
export function scoreLines(parsed) {
  const sev = SEVERITY.filter((s) => s !== '❓' || parsed.bySeverity[s]).map(
    (s) => `${s} ${parsed.bySeverity[s]}`,
  );
  const none = parsed.coverageGap ? 'none in what was read — coverage incomplete' : 'none';
  const itog = `**Summary:** ${sev.join(' · ')} — blocking: ${parsed.blocking.join(', ') || none}`;
  const raised = parsed.findings.length + parsed.killed;
  const confirmed =
    parsed.published && parsed.open === parsed.findings.length
      ? 'awaiting replies'
      : String(parsed.confirmed);
  const score = `**Score:** raised ${raised} · published ${parsed.published} · confirmed by author ${confirmed}`;
  return { itog, score };
}

/** Header numbers that contradict the findings below them. Empty = consistent (or no numbers given). */
export function headerMismatch(text, parsed = parseReport(text)) {
  const src = String(text ?? '');
  const out = [];
  const itog = src.match(/^\*\*Summary:\*\*(.*)$/m)?.[1];
  if (itog !== undefined) {
    for (const s of SEVERITY) {
      const n = itog.match(new RegExp(`${s}\\s*(\\d+)`))?.[1];
      const real = parsed.bySeverity[s];
      if (n === undefined ? real > 0 && s !== '❓' : Number(n) !== real)
        out.push(`Summary says ${s} ${n ?? '—'}, the file has ${real}`);
    }
  }
  const score = src.match(/^\*\*Score:\*\*(.*)$/m)?.[1];
  if (score !== undefined) {
    const raised = score.match(/raised\s*(\d+)/)?.[1];
    const published = score.match(/published\s*(\d+)/)?.[1];
    if (raised === undefined) out.push('Score carries no "raised N"');
    else if (Number(raised) < parsed.findings.length)
      out.push(`Score says raised ${raised}, the file holds ${parsed.findings.length} findings`);
    if (raised !== undefined && published !== undefined && Number(published) > Number(raised))
      out.push(`Score says published ${published} > raised ${raised}`);
  }
  return out;
}

/**
 * Per-finding shape, checked against the skeleton in references/report-shape.md. A finding without
 * `Where`/`Axis`/`Status` is not a work list entry — the fix agent runs from this file unattended and
 * has nothing to open, no axis to weigh it on and no field to flip. A 🔴/🟡 without `Evidence`
 * is the impression the skill's own criterion forbids: "every 🔴 and 🟡 shows run output, file:line
 * or a search result".
 */
export function shapeProblems(text, parsed = parseReport(text)) {
  const out = [];
  const names = (list) =>
    list
      .slice(0, 4)
      .map((f) => f.id)
      .join(', ') + (list.length > 4 ? ` +${list.length - 4}` : '');
  const flag = (list, what) => list.length && out.push(`${names(list)} — no "${what}" line`);
  flag(
    parsed.findings.filter((f) => !f.where),
    'Where',
  );
  flag(
    parsed.findings.filter((f) => !f.axis),
    'Axis',
  );
  flag(
    parsed.findings.filter((f) => !f.status),
    'Status',
  );
  flag(
    parsed.findings.filter((f) => !f.evidence && (f.severity === '🔴' || f.severity === '🟡')),
    'Evidence',
  );
  // A pass that dropped nothing is either a perfect pass or a pass that never verified; the skill
  // says "a reviewer with nothing ever dropped is not verifying". Make the claim explicit.
  // A live run is the one part of T2 nothing could see: the row count is written by the same hand that
  // decided how hard to try. Make the claim a line — two variations of DIFFERENT classes, or an
  // out-loud "nothing ran, because …". Silence is the only answer refused.
  const tier = TIER_LINE.exec(String(text ?? ''))?.[1];
  if (tier === 'T2') {
    const classes = VARIATIONS.map((v) => v.key).join(' · ');
    const live = LIVE_LINE.exec(String(text ?? ''))?.[1] ?? '';
    if (!live)
      out.push(
        `T2 owes a "**Live:**" line — two variations of different classes (${classes}), or "not run — <why>"`,
      );
    else if (!LIVE_NOT_RUN.test(live)) {
      const hit = VARIATIONS.filter((v) => v.re.test(live)).map((v) => v.key);
      if (hit.length < 2)
        out.push(
          `"Live" names ${hit.length ? `only "${hit[0]}"` : 'no variation class'} of four (${classes}) — T2 owes two of DIFFERENT classes, or "not run — <why>"`,
        );
    }
  }
  // The six classes only humans found in a calibration run: each answered by a command or a
  // `file:line`, or "n/a — <the search that shows it>". Unanswered, the pass is the one that missed them.
  if (tier === 'T1' || tier === 'T2') {
    const cls = CLASSES_LINE.exec(String(text ?? ''))?.[1];
    const missing = MISS_CLASSES.filter((k) => !cls?.toLowerCase().includes(k));
    if (!cls)
      out.push(
        `${tier} owes a "**Classes:**" line: ${MISS_CLASSES.join(' · ')}, each "— <cmd | file:line | n/a: the search>" (axis-1 §Six miss classes)`,
      );
    else if (missing.length)
      out.push(
        `"Classes" leaves out ${missing.join(', ')} — each of the six is answered (axis-1 §Six miss classes)`,
      );
  }
  if (tier === 'T1' || tier === 'T2') {
    const src = String(text ?? '');
    if (!COVERAGE_LINE.test(src))
      out.push(
        `${tier} owes a "**Coverage:**" line — each zone: fully · partly (<files>) · not read, plus the radius read/total (SKILL §1)`,
      );
    const passes = PASSES_LINE.exec(src)?.[1];
    const gone = HUNT_PASSES.filter((k) => !passes?.toLowerCase().includes(k));
    if (!passes)
      out.push(
        `${tier} owes a "**Passes:**" line: ${HUNT_PASSES.join(' · ')}, each "— <cmd | file:line | n/a: the search>" (SKILL §2)`,
      );
    else if (gone.length)
      out.push(`"Passes" leaves out ${gone.join(', ')} — each of the eight is answered (SKILL §2)`);
    const journal = JOURNAL_LINE.exec(src)?.[1];
    if (!journal || !(JOURNAL_COUNT.test(journal) || JOURNAL_NONE.test(journal)))
      out.push(
        `${tier} owes a "**Ledger:**" line — \`review-plan.mjs check\` output "<files with a row>/<planned> files", or "no lanes — <why>" (lanes.md)`,
      );
    const accept = ACCEPT_LINE.exec(src)?.[1];
    if (!accept || !/\d|no frame/i.test(accept))
      out.push(
        `${tier} owes an "**Acceptance:**" line — criteria counted by verdict (met · partly · not met · uncheckable · out of frame), or "no frame — <what was searched>" (axis-2 §g)`,
      );
  }
  if (tier === 'T2') {
    const bare = parsed.findings
      .filter((f) => (f.severity === '🔴' || f.severity === '🟡') && !f.rung)
      .map((f) => f.id);
    if (bare.length)
      out.push(
        `T2: ${bare.join(', ')} name no proof rung — "L1"…"L4" for what ran, or "L0 — <why nothing could run>" (live-proof.md)`,
      );
  }
  out.push(...cleanClaims(text, parsed));
  if (parsed.findings.length && !parsed.killed && !NO_KILLS_DECLARED.test(String(text ?? ''))) {
    out.push(
      'no candidate died under proof — add the `- ✗ …` lines to "What was checked", or state `**Dropped:** none — <why nothing was dropped>`',
    );
  }
  return out;
}

/** The lane ledger counts fewer files with a row than were planned. */
function journalShort(src) {
  const m = JOURNAL_COUNT.exec(JOURNAL_LINE.exec(src)?.[1] ?? '');
  return Boolean(m && +m[1] < +m[2]);
}

/** Lines claiming the change clean while the coverage ledger names a gap. */
export function cleanClaims(text, parsed = parseReport(text)) {
  if (!parsed.coverageGap) return [];
  const bad = String(text ?? '')
    .split(/\r?\n/)
    .filter(
      (l) =>
        !/^\*\*(Summary|Coverage):\*\*/.test(l) && CLEAN_CLAIM.test(l) && !CLAIM_QUALIFIED.test(l),
    );
  return bad.length
    ? [
        `"${bad[0].trim().slice(0, 60)}" — the "Coverage" line names a gap, so a clean verdict is not earned: "no blocking findings in what was read; not read: <zones>"`,
      ]
    : [];
}

function readIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** What the file will hold after this call; null when that cannot be known (the Edit fails on its own). */
function resultingText(toolName, ti, onDisk) {
  if (toolName === 'Write') return String(ti.content ?? '');
  if (toolName !== 'Edit' || onDisk === null) return null;
  const from = String(ti.old_string ?? '');
  if (!from || !onDisk.includes(from)) return null;
  const to = String(ti.new_string ?? '');
  return ti.replace_all ? onDisk.split(from).join(to) : onDisk.replace(from, () => to);
}

/** Everything a whole report is checked for — at Write, and at Stop for one written around Write. */
export function writeProblems(next) {
  const problems = [];
  const parsed = parseReport(next);
  const computed = scoreLines(parsed);
  for (const r of REQUIRED)
    if (!r.re.test(next)) problems.push(`missing header line → ${r.hint ?? computed.score}`);
  const wrong = headerMismatch(next, parsed);
  if (wrong.length)
    problems.push(
      `${wrong.join('; ')} → paste the computed lines: ${computed.itog} / ${computed.score}`,
    );
  problems.push(...shapeProblems(next, parsed));
  return problems;
}

/** PreToolUse (Write|Edit). */
export default function reviewReportGuard(input) {
  if (OFF()) return null;
  const ti = input?.tool_input ?? {};
  const filePath = String(ti.file_path ?? '');
  if (!isReviewReport(filePath)) return null;

  const tool = String(input?.tool_name ?? '');
  const onDisk = readIfExists(filePath);
  const next = resultingText(tool, ti, onDisk);
  if (next === null) return null;

  const problems = [];
  if (tool === 'Write') problems.push(...writeProblems(next));
  else {
    // Edit: nothing the file already had may be lost.
    for (const r of REQUIRED)
      if (r.re.test(onDisk) && !r.re.test(next))
        problems.push(`the edit removes the "${r.key}" header line`);
    if (LIVE_LINE.test(onDisk) && !LIVE_LINE.test(next))
      problems.push('the edit removes the "Live" line');
    if (CLASSES_LINE.test(onDisk) && !CLASSES_LINE.test(next))
      problems.push('the edit removes the "Classes" line');
    for (const [re, key] of [
      [COVERAGE_LINE, 'Coverage'],
      [PASSES_LINE, 'Passes'],
      [ACCEPT_LINE, 'Acceptance'],
    ])
      if (re.test(onDisk) && !re.test(next)) problems.push(`the edit removes the "${key}" line`);
    problems.push(...cleanClaims(next));
  }
  if (!problems.length) return null;

  return {
    decision: 'deny',
    reason:
      `review-report: ${filePath.split(/[\\/]/).pop()} — ${problems.join(' · ')}. ` +
      'Shape: <kit>/skills/deep-review/references/report-shape.md. After a status flip or a publish, ' +
      '`node <kit>/tools/review-score.mjs <report> --write` recomputes Summary and Score.',
  };
}

// ---- Stop: reports written around Write/Edit -------------------------------------------------------
const REPORT_IN_CMD = /[^\s'"`<>|;&(]*[\\/]\.agent[\\/]reviews[\\/][^\s'"`<>|;&\\/]+\.agent\.md/gi;
// A command that puts bytes into a report directly. The two report tools (review-sync, review-score)
// rewrite blocks of legacy reports by design and are not a bypass.
const DIRECT_WRITE =
  /(^|[^<>=\d&])>>?\s*[^\s&]|\btee\b|Out-File|Set-Content|Add-Content|writeFileSync|\b(cp|mv|Copy-Item|Move-Item)\b/;
const REPORT_TOOL = /review-(sync|score)\.mjs/;
const toNative = (p, cwd) => {
  const q = p.replace(/^~(?=[\\/])/, homedir()).replace(/^\/([a-z])\//i, '$1:/');
  return isAbsolute(q) || !cwd ? q : join(cwd, q);
};

/**
 * Stop (the Stop dispatcher). A report CREATED this turn, or written this turn by a shell command that
 * names it, gets the full Write check — once; `stop_hook_active` lets the retry through. A legacy
 * report merely touched (a status flip by review-sync) is left alone, exactly as Edit leaves it.
 */
export function reviewReportAtStop(input) {
  if (OFF() || input?.stop_hook_active || inSubagent(input)) return null;
  let records;
  try {
    records = sinceLastCompact(readTail(String(input?.transcript_path ?? '')));
  } catch {
    return null;
  }
  if (!records?.length) return null;
  const { index } = lastUserSpeech(records);
  // Right after a compact the window holds no typed speech (index -1): bound the turn by the window's
  // first stamped record, never by 0 — 0 made every report ever written "changed this turn".
  const since =
    Date.parse(records[index]?.timestamp ?? '') ||
    Date.parse(records.find((r) => r?.timestamp)?.timestamp ?? '') ||
    0;
  if (!since) return null;
  const cwd = String(input?.cwd ?? '');
  const direct = new Set(); // reports a shell command wrote this turn
  const seen = new Set();
  for (const e of toolEvents(records.slice(index + 1))) {
    if (e.kind !== 'use' || !/^(Bash|PowerShell)$/.test(String(e.name ?? ''))) continue;
    const cmd = String(e.input?.command ?? '');
    for (const m of cmd.matchAll(REPORT_IN_CMD)) {
      const abs = toNative(m[0], cwd);
      seen.add(abs);
      if (DIRECT_WRITE.test(cmd) && !REPORT_TOOL.test(cmd)) direct.add(abs);
    }
  }
  if (cwd)
    try {
      for (const n of readdirSync(join(cwd, '.agent', 'reviews')))
        if (n.endsWith('.agent.md')) seen.add(join(cwd, '.agent', 'reviews', n));
    } catch {
      /* no reviews folder here */
    }
  const problems = [];
  for (const f of seen) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    if (!direct.has(f) && !(st.birthtimeMs >= since)) continue;
    const text = readIfExists(f);
    const found = text === null ? [] : writeProblems(text);
    if (found.length)
      problems.push(
        `${basename(f)}: ${found.slice(0, 4).join(' · ')}${found.length > 4 ? ` (+${found.length - 4})` : ''}`,
      );
  }
  if (!problems.length) return null;
  return {
    decision: 'block',
    reason:
      `review-report (Stop): a review report changed this turn outside Write/Edit and fails its shape — ${problems.join(' | ')}. ` +
      'Rewrite it with the Write tool (the guard checks it there) per <kit>/skills/deep-review/references/report-shape.md, then finish.',
  };
}
